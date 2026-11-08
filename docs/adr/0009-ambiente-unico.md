# ADR 0009 — Ambiente único

- **Status**: Aceita
- **Autor(es)**: Guilherme Müller
- **Data**: 2026-11-08
- **Repos afetados**: `oficina-infra-k8s`, `oficina-infra-db`,
  `oficina-os-service`, `oficina-billing-service`,
  `oficina-execucao-service`, `oficina-auth-lambda`

## Contexto

A fase anterior exigia dois ambientes e entregou dois, `homolog` e
`prod`, conforme o [ADR 0002](0002-estrategia-escalabilidade-e-ambientes.md). O enunciado da Fase 4 **não pede ambiente
nenhum** além de "deploy automatizado em ambiente Kubernetes".

Com três serviços, manter dois ambientes custaria **2 VPC Links, 2 stages
de API Gateway, 6 bancos, 6 filas** e o dobro do tempo de deploy,
tudo isso sem requisito que o justifique.

Além do custo, a fase anterior deixou uma dívida real: um **VPC Link
único apontando para o NLB de produção**. Como o Link era um só, as
requisições de homologação (`/homolog/*`) caíam em produção.

## Decisão

Vamos operar **um só ambiente**, `prod`. O push em `main` faz deploy em
`prod`, e não há ambiente intermediário.

O argumento mais forte não é a economia, e sim a dívida: **com um
ambiente, o bug do VPC Link deixa de existir, em vez de ser
contornado.** Corrigi-lo mantendo dois ambientes exigiria um segundo VPC
Link, um segundo NLB e a disciplina de nunca cruzar os dois. Removendo o
segundo ambiente, não há segundo destino para a requisição errar. A
correção é a ausência do defeito.

O custo evitado é o listado no Contexto: 2 VPC Links, 2 stages, 6 bancos,
6 filas e o dobro do deploy, algo em torno de 6h de trabalho
que não entregam requisito.

## Consequências

- Positivas: a dívida do VPC Link some por construção; menos recursos
  para criar, pagar e manter (1 VPC Link, 1 stage, 3 bancos (2 bancos
  lógicos no RDS + 1 tabela DynamoDB), 3 filas); pipeline mais curto e simples.
- Negativas / trade-offs aceitos: **não há ambiente para validar uma
  mudança de infraestrutura antes de ela chegar em produção**. Isso é
  uma perda real, não um detalhe: um `apply` errado de Terraform atinge
  o único ambiente que existe. O risco é mitigado apenas por pipeline com
  testes e por migrations versionadas, o que reduz a chance de erro de
  aplicação, mas não substitui um ensaio de infraestrutura. Aceitamos
  isso porque o projeto não tem usuários reais e o ambiente é recriável.
- Trabalho decorrente: manter **uma stage só** no API Gateway (`prod`),
  removendo a stage de homologação; remover os bancos por ambiente
  (`oficina_homolog` e `oficina_prod`), substituídos pelos bancos do
  [ADR 0008](0008-um-rds-dois-bancos-logicos.md); remover o segundo
  namespace e o alias de homologação da Lambda; apontar o VPC Link
  único para o NLB do ingress.

Relação com outros ADRs: este ADR **substitui parcialmente o ADR 0002**
([ADR 0002](0002-estrategia-escalabilidade-e-ambientes.md)), na parte que
define dois ambientes (namespaces, databases lógicos e aliases por
ambiente). A parte de escalabilidade do ADR 0002 permanece válida. O
arquivo do ADR 0002 não é alterado neste PR; a atualização do seu status
fica para um PR separado. Também completa o [ADR 0006](0006-api-gateway.md), cuja seção de
"dois stages" deixa de se aplicar.
