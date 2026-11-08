# ADR 0008 — Um RDS, dois bancos lógicos, zero grants cruzados

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Repos afetados**: `oficina-infra-db`, `oficina-os-service`,
  `oficina-billing-service`, `oficina-auth-lambda`

## Contexto

Ao dividir o monólito, o OS Service e o Billing Service passam a ter
dados relacionais próprios (OS, cliente e veículo de um lado; orçamento
e pagamento do outro, com `Decimal` e ACID). O enunciado exige que
**nenhum serviço acesse o banco de outro**.

Esse requisito admite uma leitura adversa: "banco próprio" lido como
"instância própria". Sob essa leitura, dois serviços compartilhando uma
instância RDS estariam errados. A leitura não se sustenta, porque o que
impede um serviço de enxergar os dados do outro é a permissão de acesso,
não o hardware onde o banco roda — mas a decisão precisa registrar isso
com evidência e com a conta de custo, para quem ler depois.

## Decisão

**Uma** instância `db.t4g.micro` hospeda **dois bancos lógicos**,
`oficina_os` e `oficina_billing`. Cada banco tem um **role próprio**, dono
do seu banco, e há **zero grants cruzados**: o role do OS não tem
`CONNECT` em `oficina_billing`, e o do Billing não tem em `oficina_os`.

O isolamento é materializado pela **ausência de grants**, não pela
separação de instâncias. Duas instâncias com um role compartilhado entre
elas seriam menos isoladas que um RDS com roles separados. E isso é
verificável: o role do Billing tentando um `SELECT` em `oficina_os` deve
receber `permission denied`. Esse teste, executado com `psql`, é a
evidência de isolamento e entra na verificação da fase.

O terceiro banco do sistema é **DynamoDB**, no serviço de Execução, e
**não** está nesta instância (ver a
[RFC 0007](../rfc/0007-banco-nosql.md)).

**Custo e reversibilidade.** Uma segunda `db.t4g.micro` custaria cerca de
**US$12/mês**, e passar a usá-la é **1 PR**: apontar o `DATABASE_URL` do
Billing para a nova instância e mover o banco. O crédito AWS disponível é
de ~US$112; a instância única, no free tier (750h/mês), custa ~0. A
economia é relevante para o orçamento da fase, não mesquinha. Se a
avaliação exigir instância própria, a decisão se reverte barato.

## Consequências

- Positivas: custo de banco relacional ~0 no free tier; um único RDS para
  operar, monitorar e fazer backup; isolamento verificável por teste, e
  não por convenção.
- Negativas / trade-offs aceitos: as duas bases compartilham CPU, memória
  e conexões da mesma instância, então um serviço pode degradar o outro
  sob carga, e uma falha da instância derruba os dois. Não há isolamento
  de falha, só de acesso. Aceitável no volume deste projeto e para uma
  `db.t4g.micro` sem SLA exigido; a separação em instâncias é o caminho
  de saída já mapeado.
- Negativas / trade-offs aceitos (acesso cruzado remanescente): o Lambda
  de auth (`oficina-auth-lambda`) lê a tabela `clientes`, de que o OS
  Service é dono, direto no banco. É o único acesso cruzado que resta no
  sistema; fica como dívida declarada, com a correção (consultar o OS
  Service por HTTP) fora do escopo desta fase.
- Trabalho decorrente: criar em `oficina-infra-db` um root
  `bootstrap-db/` que cria os dois bancos e os dois roles, sem grants
  cruzados; **remover** os bancos `oficina_homolog` e `oficina_prod` que
  existiam na fase anterior; registrar o teste de `permission denied` na
  verificação da fase; cada serviço roda as migrations só no próprio
  banco; repontar o secret `DATABASE_URL_PROD` do `oficina-auth-lambda`
  para `oficina_os` (onde a tabela `clientes` passa a viver) e remover a
  variável de homologação do Terraform dele, sob pena de o Lambda de auth
  parar de funcionar quando `oficina_prod` for removido.
