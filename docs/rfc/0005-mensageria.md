# RFC 0005 — Mensageria assíncrona entre os microsserviços

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Repos afetados**: oficina-os-service, oficina-billing-service,
  oficina-execucao-service, oficina-infra-k8s

## Contexto

O enunciado da Fase 4 do Tech Challenge exige comunicação síncrona
(REST) e assíncrona (mensageria) entre os microsserviços, além de uma
Saga para o fluxo da ordem de serviço. Hoje não há nenhuma mensageria.
Duas restrições moldam a escolha: o crédito AWS é limitado e o ambiente
é destruído (`terraform destroy` do cluster EKS) ao fim de cada dia, e
um único desenvolvedor precisa entregar três serviços em 13 dias, sem
tempo para operar infraestrutura de mensageria.

## Alternativas consideradas

### Opção A — SNS + SQS

- Prós: serviços totalmente gerenciados e fora do cluster, então
  sobrevivem ao `destroy` do EKS; free tier de 1 milhão de requisições
  por mês cada, suficiente para o volume do projeto; não há broker para
  dimensionar, versionar ou monitorar; fan-out nativo (tópico para
  várias filas) com filter policy; DLQ e redrive são recursos de
  primeira classe; IAM já é o modelo de acesso usado no restante da AWS.
- Contras: filas Standard não garantem ordem e entregam at-least-once;
  filas FIFO resolveriam a ordem, mas com menor vazão e sem o ganho que
  o projeto precisa; acopla o projeto à AWS (sem portabilidade); sem
  replay de histórico como no Kafka.

### Opção B — RabbitMQ

- Prós: protocolo AMQP maduro, roteamento rico (exchanges, bindings),
  ordem por fila, ack explícito e boa ergonomia local.
- Contras: o Amazon MQ gerenciado exige um broker ligado por hora,
  provisionado dentro da VPC, e cobra por hora de instância; por isso não
  sobrevive ao `terraform destroy` diário do cluster (critério D2: o
  ambiente é descartado e recriado todo dia). Já auto-hospedado no EKS
  morre junto com o cluster a cada `destroy`,
  perdendo filas e mensagens pendentes, e exige volume persistente,
  versionamento, monitoramento e upgrades — o oposto de zero operação.

### Opção C — Apache Kafka

- Prós: log durável com replay, ordem por partição, vazão muito acima
  da necessária e ecossistema forte para streaming de eventos.
- Contras: o MSK provisionado cobra por broker/hora, sem free tier
  útil, e consome o crédito mesmo ocioso; o MSK Serverless reduz o
  dimensionamento, mas cobra por cluster/hora e por partição, sem custo
  zero; exige modelar partições, grupos de consumidores e offsets —
  complexidade desproporcional a três serviços e poucos eventos.

## Decisão / Recomendação

**SNS + SQS** (Opção A). Três critérios decidiram, e só ela atende a
todos: (1) **cabe no free tier** — 1 milhão de requisições/mês em cada
serviço cobre o projeto sem custo, ao contrário de MSK e Amazon MQ, que
cobram por hora de instância ligada; (2) **sobrevive ao `terraform destroy` do cluster EKS**
— tópicos e filas vivem fora do cluster, então o descarte diário do
ambiente não apaga mensagens nem assinaturas, o que RabbitMQ no EKS não
garante; (3) **zero infraestrutura para operar** — sem broker para
dimensionar, versionar ou monitorar, o que libera o tempo escasso para
as regras de negócio e a Saga.

## Consequências

- Filas **Standard** (não FIFO). Por isso cada consumidor mantém uma
  tabela `mensagens_processadas` e garante **idempotência por
  `messageId`**: mensagem já registrada é descartada sem reprocessar.
- Cada fila tem `redrive_policy` com `maxReceiveCount = 3` e uma **DLQ**
  própria; mensagens que falham três vezes vão para a DLQ para análise.
- Os tópicos SNS assinam as filas com **filter policy** por
  `message_attributes.evento`, de modo que cada serviço recebe só os
  eventos de seu interesse.
- `correlationId` e `traceparent` viajam nos message attributes, para o
  trace distribuído do New Relic atravessar a fila (ver RFC 0004).
- **Trade-off aceito, não detalhe**: Standard significa **sem ordem
  garantida e com entrega at-least-once**. Consumidores precisam ser
  idempotentes e tolerar eventos fora de ordem (a Saga deve checar o
  estado atual antes de aplicar uma transição). Aceitamos esse custo
  em troca de gratuidade e zero operação.
- Os tópicos ficam em `oficina-infra-k8s` (root `mensageria/`); fila,
  DLQ, subscription e IAM ficam no repo de cada serviço (ADR 0007).
- Risco aceito: dependência da AWS e ausência de replay de histórico.

## Referências

- Enunciado da Fase 4 do Tech Challenge
- [ADR 0007](../adr/0007-propriedade-topicos-filas.md)
- [RFC 0001](0001-provedor-nuvem.md)
- [RFC 0004](0004-ferramenta-observabilidade.md)
- Documentação oficial do Amazon SNS: https://docs.aws.amazon.com/sns/
- Documentação oficial do Amazon SQS: https://docs.aws.amazon.com/sqs/
