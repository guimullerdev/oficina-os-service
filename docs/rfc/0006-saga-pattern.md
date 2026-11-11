# RFC 0006 — Estratégia de Saga: orquestrada vs coreografada

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Atualizado em 2026-11-11**: nomes de eventos alinhados ao código
- **Repos afetados**: `oficina-os-service` (orquestrador),
  `oficina-billing-service`, `oficina-execucao-service`,
  `oficina-infra-k8s`

## Contexto

Hoje, no monólito, o fluxo da Ordem de Serviço (OS) é uma cadeia de
chamadas em processo. `FinishDiagnosisUseCase` (módulo `service-orders`)
chama `GerarOrcamentoUseCase` (módulo `orcamentos`) diretamente, e aprovar
um orçamento mutaciona o agregado da OS **na mesma transação local**. Se
qualquer passo falha, o `ROLLBACK` do banco desfaz tudo.

Na Fase 4, `service-orders` e `orcamentos` viram serviços e bancos
separados. Não existe mais transação atravessando a fronteira: um
passo pode ser confirmado e o seguinte falhar, deixando o sistema
parcialmente atualizado. É esse vácuo que a Saga preenche — uma sequência
de transações locais, cada uma com uma **compensação** explícita para
desfazê-la. O enunciado da Fase 4 exige descrever e justificar a
estratégia; falta decidir quem comanda a sequência.

## Alternativas consideradas

### Opção A — Saga orquestrada, orquestrador no OS Service

- Prós: fluxo e compensações ficam num único lugar, legível e
  consultável; o estado de cada passo é persistido (`saga_passos`) e pode
  ser mostrado na tela; o caminho inteiro é testável com um cenário BDD.
- Contras: OS Service vira ponto central de coordenação; exige
  construir máquina de estados, outbox e tratamento de timeout.

### Opção B — Saga coreografada

- Prós: sem coordenador central; cada serviço só reage a eventos.
- Contras: a lógica do fluxo se espalha pelos três repositórios; o
  rollback fica implícito, emergindo de reações encadeadas que ninguém
  lê num só lugar; difícil de demonstrar ao vivo.

### Opção C — AWS Step Functions

- Prós: orquestrador gerenciado, com retries e timeouts nativos.
- Contras: acopla o fluxo de negócio a um serviço AWS fora do código;
  sai do free tier (cobra por transição de estado); tira do repositório
  a evidência que a avaliação pede.

## Decisão / Recomendação

**Saga orquestrada, com o orquestrador dentro do OS Service** (Opção A).

> A Saga do sistema é **orquestrada**: o OS Service coordena o fluxo
> completo da Ordem de Serviço (orçamento, aprovação, execução e
> pagamento) e registra cada passo e cada compensação nas tabelas
> `saga_instancias` e `saga_passos`. Escolhemos orquestração porque
> mantém fluxo e rollback num único lugar legível, que pode ser mostrado
> na tela e coberto por um cenário BDD de ponta a ponta. A coreografia
> espalharia a mesma lógica por três repositórios e deixaria o rollback
> implícito, o que é indefensável numa entrega avaliada.

Motivos: `saga_passos` mostra fluxo e compensações num
único lugar, exibível na tela; o rollback precisa ser demonstrado ao
vivo num vídeo de no máximo 15 minutos; e o caminho inteiro (feliz e
compensado) precisa ser coberto por um cenário BDD. O contraponto
honesto: coreografia espalharia a mesma lógica por três repositórios e
deixaria o rollback implícito.

Step Functions fica de fora: acopla o fluxo de negócio a um serviço AWS
fora do código, sai do free tier por transição de estado e tira do
repositório a evidência que a avaliação pede.

## Consequências

**Persistência e confiabilidade.** O OS Service ganha as tabelas
`saga_instancias` e `saga_passos`. Para publicar eventos, usa o **outbox
pattern**: tabela `outbox` mais um publisher periódico, garantindo
publicação at-least-once **na mesma transação** do agregado. Sem outbox,
haveria uma janela entre salvar o agregado e publicar no SNS: se o
processo caísse ali, o agregado ficaria salvo e o evento se perderia, com
a saga parada para sempre. Como a entrega é at-least-once, **cada**
consumidor mantém a tabela `mensagens_processadas` com `messageId` único
e descarta duplicatas (idempotência).

**Caminho feliz — 6 passos:**

| # | Passo | Comando / evento | Status do passo (a saga não altera a OS no caminho feliz) |
|---|---|---|---|
| 1 | `ABRIR_OS` | `POST /os` → `os.criada` | `CONCLUIDO` |
| 2 | `GERAR_ORCAMENTO` | OS publica `diagnostico.concluido`; Billing consome → `orcamento.gerado` | `CONCLUIDO` |
| 3 | `APROVAR_ORCAMENTO` | `PATCH /orcamentos/{id}/aprovar` → `orcamento.aprovado` | `CONCLUIDO` |
| 4 | `EXECUTAR` | OS publica `os.execucao.solicitada`; Execução consome → `execucao.iniciada`, `execucao.concluida` | `CONCLUIDO` |
| 5 | `COBRAR` | OS publica `os.cobranca.solicitada`; Billing cria a preference no Mercado Pago | `EM_ANDAMENTO` (aguarda webhook) |
| 6 | `CONFIRMAR` | webhook MP → `pagamento.confirmado`; OS publica `os.finalizada` | `CONCLUIDO` |

**Compensações — 5 casos:**

| Falha | Evento | Compensação |
|---|---|---|
| Orçamento reprovado | `orcamento.reprovado` | OS → `REPROVADA`, passo `COMPENSADO`; Execução libera a reserva de peças |
| Execução falhou | `execucao.falhou` | OS volta para `APROVADA`, passo `COMPENSADO`; Billing cancela o orçamento |
| Pagamento recusado | `pagamento.recusado` | Billing cancela o orçamento; saga `PENDENTE`, OS não muda de status |
| Timeout de etapa | `saga.passo.expirado` | compensa o passo; `saga_passos.status = COMPENSADO`; OS não muda de status |
| Mensagem envenenada | 3 tentativas falhas → DLQ | alerta New Relic na profundidade da DLQ |

**Inspeção.** `GET /os/{id}/saga` devolve a instância e seus passos.
**Custo negativo aceito.** O OS Service passa a ser ponto central de
coordenação: se ele ficar indisponível, os fluxos em andamento
paralisam. Nenhum dado se perde, porque eventos pendentes ficam no
`outbox` e são publicados quando o serviço volta. Além disso, as FKs
`orcamentos.os_id` e `movimentacoes_estoque.os_id` atravessam a nova
fronteira e viram referência fraca (coluna `os_id` sem constraint).

## Referências

- [ADR 0007](../adr/0007-propriedade-topicos-filas.md)
- [RFC 0005](0005-mensageria.md)
- Enunciado do Tech Challenge, Fase 4 (descrever e justificar a Saga)
- H. Garcia-Molina e K. Salem, "Sagas", ACM SIGMOD, 1987
- Chris Richardson, "Pattern: Saga", microservices.io
