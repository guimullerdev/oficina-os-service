# RFC 0007 — Banco NoSQL para o serviço de Execução e Produção

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Repos afetados**: `oficina-execucao-service`, `oficina-os-service`

## Contexto

O enunciado da Fase 4 exige **pelo menos um banco SQL e pelo menos um
banco NoSQL** no sistema. Hoje só existe PostgreSQL
([RFC 0002](0002-banco-de-dados-gerenciado.md)). A pergunta, porém, não é só "qual
NoSQL": é **qual serviço justifica NoSQL de verdade**. Escolher o serviço
errado produziria um NoSQL decorativo, adicionado só para cumprir o
requisito e que não resolve problema nenhum.

O serviço de Execução e Produção foi escolhido porque sua carga é
**append-heavy** (uma linha do tempo de eventos de diagnóstico e reparo,
que só cresce) e de **schema flexível** (cada tipo de evento carrega
campos diferentes). Restrições adicionais: o crédito AWS restante é de
~US$112, e o cluster EKS é destruído (`terraform destroy`) ao fim de cada
dia para poupar esse crédito. O ambiente é um só (`prod`).

## Alternativas consideradas

### Opção A — DynamoDB

- Prós: 25 GB de storage no free tier e requests on-demand, que custam
  centavos neste volume; não precisa estar na VPC, então não depende do
  cluster e **sobrevive ao `terraform destroy`** do EKS; é AWS, mesmo
  IAM, sem fornecedor novo; o Terraform são ~30 linhas.
- Contras: não há query ad-hoc nem join, e toda consulta nova exige um
  índice pensado antes; o modelo single-table é menos intuitivo para
  quem vem de SQL.

### Opção B — MongoDB Atlas (free tier M0)

- Prós: modelo de documentos natural para eventos de schema flexível;
  queries ad-hoc e índices secundários mais livres; o M0 é gratuito.
- Contras: é **um fornecedor a mais**, fora da AWS, com credenciais,
  allowlist de rede e conta próprios; o M0 é compartilhado e limitado.

### Opção C — Amazon DocumentDB

- Prós: API compatível com MongoDB, dentro da AWS e gerenciado.
- Contras: **não tem free tier permanente** (existe só um teste de 30
  dias para contas novas: 750 h de `db.t3.medium`, 30M de I/Os e 5 GB) e
  exige instância dentro da VPC; um cluster de instância única
  `db.t3.medium` custa ~US$57/mês (US$0,078/h em us-east-1; estimativas
  de terceiros chegam a ~US$80/mês), ligado full-time, o que não cabe num
  crédito de ~US$112.

## Decisão / Recomendação

**DynamoDB**, na tabela do serviço de Execução e Produção, com a seguinte
modelagem:
- `PK = OS#<osId>`, `SK = EVT#<iso>`: modela a linha do tempo de execução
  **sem join nenhum**; a leitura "todos os eventos de uma OS" é um único
  `Query` por partição, já ordenado por data;
- a fila de execução é um **GSI** chamado `fila`, por
  `status#prioridade#dataAbertura`;
- 25 GB de storage no free tier e requests **on-demand** (centavos neste
  volume);
- **não precisa estar na VPC**, então não depende do cluster;
- **sobrevive ao `terraform destroy`** do EKS, que acontece ao fim de
  cada dia; a tabela fica num Terraform próprio, fora do ciclo do cluster;
- o Terraform são ~30 linhas.

Critério decisivo: cabe no crédito, não adiciona fornecedor e casa com a
forma da carga (append e leitura por partição).

### Por que OS e Billing continuam em SQL

- **OS Service** (`oficina_os`): a Ordem de Serviço é um agregado com
  **chaves estrangeiras** para cliente e veículo, e um histórico de status
  com **índice composto**. Isso é dado relacional por natureza;
  integridade referencial e consultas cruzadas são o que o SQL faz bem.
- **Billing Service** (`oficina_billing`): o orçamento mexe com
  `Decimal(10,2)` e com pagamento, onde **ACID não é negociável**. Uma
  aprovação e um registro de pagamento não podem ficar pela metade.

Usar NoSQL nesses dois seria **pior, não mais moderno**: trocaria FKs e
transações por validação manual na aplicação, sem ganho de escala que o
volume justifique. A divisão final é SQL onde há relações e dinheiro,
NoSQL onde há uma linha do tempo.

## Consequências

- Custo aceito: toda consulta nova precisa de um índice desenhado de
  antemão; fora de `PK` e do GSI `fila`, só com novo GSI (`Scan` não é
  aceitável em produção).
- Não há `JOIN` com os dados de OS: o serviço guarda uma referência fraca
  `osId`, sem FK, e dados que ele não é dono (cliente, veículo, itens do
  orçamento) chegam por evento, ficando como cópia local do que ele
  precisa.
- A equipe passa a operar **dois modelos de dados** (relacional com
  Prisma e chave-valor com GSI), com suas modelagens, testes e formas de
  falha distintas.
- O adapter usa **AWS SDK v3** (`@aws-sdk/client-dynamodb` e
  `lib-dynamodb`) e os testes unitários usam `aws-sdk-client-mock`; os
  testes de integração rodam contra LocalStack.
- A tabela vive fora do ciclo do cluster: o custo é contínuo (centavos)
  e ela precisa de `terraform destroy` explícito ao fim do projeto.

## Referências

- Enunciado da Fase 4 — Tech Challenge (13SOAT)
- [RFC 0002](0002-banco-de-dados-gerenciado.md)
- [RFC 0001](0001-provedor-nuvem.md)
- [ADR 0008](../adr/0008-um-rds-dois-bancos-logicos.md)
- Documentação AWS DynamoDB: single-table design e GSI
