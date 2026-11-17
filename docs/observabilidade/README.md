# Observabilidade — New Relic

Dashboard ativo: **https://one.newrelic.com/dashboards/detail/ODUxMDQwMXxWSVp8REFTSEJPQVJEfGRhOjEzNTc4MDYy?account=8510401**

Definição versionada:
[`dashboard-newrelic.json`](dashboard-newrelic.json).

## Como importar

New Relic → **Dashboards** → **Import dashboard** → colar o conteúdo do
arquivo. Sem passo intermediário: o `accountId` da conta (`8510401`) já está
preenchido.

O account id não é credencial — ele aparece na URL de qualquer sessão do
New Relic (`one.newrelic.com/...?account=8510401`) e serve só para
identificar a conta. Se um dia o dashboard for importado em outra conta, é
substituir os `"accountIds": [8510401]`.

> Nota para quem for editar: o New Relic **rejeita** `0`, `null` ou string
> nesse campo (`[INVALID_INPUT] 'accountId' or 'accountIds' can not
> contain: 0, null values or strings`). Tem que ser o número da conta.

## De onde vem cada dado

O PDF da Fase 3 exige três painéis nominais; a Fase 4 acrescenta a página **Saga e mensageria** (saga, filas e rastreamento entre os 3 serviços). Vale saber a origem de cada um, porque
dois vêm de coisas que a aplicação emite de propósito — se alguém remover a
emissão, o painel não quebra, ele simplesmente esvazia.

| Painel exigido | Fonte | Emitido por |
|---|---|---|
| Volume diário de OS | `Log` com `req.url = '/os'` e `res.statusCode = 201` | `nestjs-pino` (automático por requisição) |
| Tempo médio por status | `Log` com `event = 'os.status.transicao'` | `OsStatusMetricsInterceptor` |
| Erros e falhas | `Log` com `event` em (`os.processamento.falha`, `requisicao.falha`) | `HttpExceptionFilter` |
| Painel da saga (passos e desfecho) | `Log` com `event = 'saga.passo.transicao'` (`sagaId`, `osId`, `passo`, `ordem`, `statusAnterior`, `statusNovo`, `correlationId`) e `event = 'saga.status'` (`sagaId`, `osId`, `statusAnterior`, `statusNovo`, `correlationId`); `statusAnterior` nulo na criação | `SagaMetrics`, logado só depois do commit da transação que gravou a transição (`SagaOrchestrator.emitirTransicoes`) |
| Profundidade das DLQs e backlog das filas | `Metric` `aws.sqs.ApproximateNumberOfMessagesVisible` por `aws.sqs.QueueName` (`LIKE '%dlq'` / `NOT LIKE`) | integração AWS do New Relic (polling de 5 min), root `oficina-infra-k8s/observabilidade/`; a mesma métrica alimenta o alerta `Mensagem parada em DLQ` |
| Rastreamento por `correlationId` | `Log` com `allColumnSearch({{correlationId}})`: campo `correlationId` no JSON do OS e texto `correlationId=<id>` nas mensagens do Billing e da Execução | `nestjs-pino` (OS) e `Logger` do Nest (Billing, Execução), via `newrelic-logging` do cluster |

### Por que o tempo médio por status precisou de código

As transições de status já eram registradas em `historicoStatus`, **mas só
no Postgres** — e o New Relic não consulta o banco da aplicação. Sem emitir
nada, esse painel ficaria permanentemente vazio.

O `OsStatusMetricsInterceptor` resolve isso: em toda rota que devolve uma
OS, ele calcula quanto tempo ela passou no status anterior
(`OrdemDeServico.duracaoUltimoStatusSegundos`, cálculo puro sobre o
histórico) e emite um log estruturado com `statusAnterior`, `statusNovo` e
`duracaoSegundos`.

## Eventos estáveis

Os identificadores de evento são constantes exportadas e cobertas por teste:

| Constante | Valor | Onde |
|---|---|---|
| `FALHA_PROCESSAMENTO_OS` | `os.processamento.falha` | `common/filters/http-exception.filter.ts` |
| `FALHA_REQUISICAO` | `requisicao.falha` | idem |
| `EVENTO_TRANSICAO_STATUS` | `os.status.transicao` | `service-orders/presentation/interceptors/` |

São testados porque renomear um deles **não quebra nada visivelmente**: o
dashboard e o alerta continuam existindo e simplesmente param de receber
dados. O teste é o que torna essa falha barulhenta.

## Alerta de falha no processamento de OS

Condição sugerida (NRQL alert):

```sql
SELECT count(*) FROM Log WHERE event = 'os.processamento.falha'
```

Disparar acima de 0 numa janela de 5 minutos. Só 5xx chega aqui — 4xx é o
chamador errando (CPF inválido, validação) e alertar nisso geraria ruído
constante, até o alerta virar algo que todo mundo ignora.

## Pré-requisitos para os painéis terem dados

- `NEW_RELIC_ENABLED=true` e `NEW_RELIC_LICENSE_KEY` no Secret da aplicação
  (o pipeline já popula ambos)
- Agente do New Relic instalado no cluster, para os dados de CPU/memória —
  feito pelo pipeline de `oficina-infra-k8s` via Helm
- Tráfego real: em ambiente recém-criado, gerar chamadas antes de gravar o
  vídeo, senão os painéis aparecem vazios

### Duplicidade dos logs do OS

O OS chega ao New Relic por dois caminhos: o `newrelic-logging` do cluster
(com `container_name`) e o *logs in context* do agente APM (sem
`container_name`). Por isso os widgets de saga filtram
`container_name = 'oficina-os-service'` e o rastreamento exige
`container_name IS NOT NULL`: sem isso cada evento aparece duas vezes.
