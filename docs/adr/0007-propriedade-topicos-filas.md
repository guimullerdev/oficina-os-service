# ADR 0007 — Propriedade de tópicos, filas e subscriptions

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Repos afetados**: `oficina-infra-k8s` (tópicos),
  `oficina-os-service`, `oficina-billing-service`,
  `oficina-execucao-service` (filas, DLQs, subscriptions, IAM)

## Contexto

A Fase 4 adota SNS + SQS como mensageria entre os três serviços (ver a
[RFC 0005](../rfc/0005-mensageria.md)). Resta decidir quem cria cada
recurso em Terraform, e a resposta precisa satisfazer duas coisas que
puxam em direções opostas: o enunciado pede que cada microsserviço seja
dono da sua infraestrutura, e a mensageria só funciona se tópicos e
filas existirem na ordem certa.

O problema de ordem é concreto. Uma subscription SNS → SQS exige que o
tópico já exista no momento do `apply`. Se cada serviço criasse o tópico
que **consome**, o OS precisaria do tópico `oficina-billing-events` (para
ouvir o orçamento), o Billing precisaria de `oficina-os-events` (para
ouvir a OS criada) e a Execução precisaria dos dois. Cada `apply`
dependeria de um recurso que só existe depois do `apply` de outro repo: o
primeiro `apply` do sistema entraria em deadlock de ordem.

## Decisão

A propriedade é dividida pelo critério "quem os dois lados conhecem":

| Recurso | Dono (repo) | Nome |
|---|---|---|
| 3 tópicos SNS | `oficina-infra-k8s`, root novo `mensageria/` | `oficina-os-events`, `oficina-billing-events`, `oficina-execucao-events` |
| Fila + DLQ + subscription + policy IAM de cada serviço | o próprio repo do serviço, em `terraform/` | `oficina-{os,billing,execucao}-queue` e `-dlq` |

O barramento é a peça que **os dois lados** conhecem — o mesmo raciocínio
do [ADR 0006](0006-api-gateway.md) sobre o API Gateway, que também mora em `oficina-infra-k8s`
por ser o recurso que mais de um repo precisa enxergar. Com os tópicos
num root compartilhado e aplicado primeiro, o grafo de dependência vira
uma linha reta: `mensageria/` → `terraform/` de cada serviço, sem ciclo.

Só os tópicos sobem para o root compartilhado. A fila, a DLQ, a
subscription e a policy IAM ficam no repo do serviço que as consome.
Assim cada microsserviço continua dono da própria infraestrutura de
consumo, que é o que o enunciado pede.

## Consequências

- Positivas: a ordem de `apply` é determinística e sem deadlock; cada
  serviço pode recriar a sua fila, DLQ e subscription sem tocar nos
  demais; o barramento tem um dono único e um state único, em vez de
  três repos disputando o mesmo tópico.
- Negativas / trade-offs aceitos: os tópicos não estão no repo de quem
  publica neles, então adicionar um tópico novo exige PR em
  `oficina-infra-k8s` antes do PR do serviço. A subscription mora no
  repo do consumidor mas depende de um ARN de outro repo, o que é um
  acoplamento de leitura (via output do state) que precisa ser mantido
  estável. Aceitável: são três tópicos, e o conjunto muda raramente.
- Trabalho decorrente: criar o root `mensageria/` em `oficina-infra-k8s`,
  com state key `infra-k8s/mensageria/terraform.tfstate` e outputs dos
  ARNs dos três tópicos; criar um `terraform/` próprio em cada um dos
  três repos de serviço, lendo esses ARNs e criando fila, DLQ,
  subscription e policy IAM; aplicar `mensageria/` antes de qualquer
  `terraform/` de serviço no pipeline.
