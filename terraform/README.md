# Terraform — mensageria do os-service

Root que cria a fila SQS principal e a DLQ do `os-service`, suas assinaturas nos
tópicos SNS das outras duas partes da oficina, a queue policy e a policy IAM de
mensageria. Decisão de propriedade em [ADR 0007](../docs/adr/0007-propriedade-topicos-filas.md).

## O que este root cria

- Filas `oficina-os-queue` (principal) e `oficina-os-dlq` (DLQ).
- Redrive policy na principal: após `maxReceiveCount` = 3 recebimentos, a mensagem vai para a DLQ.
- Redrive allow policy na DLQ: aceita somente a fila principal como origem.
- Queue policy: somente os tópicos de Billing e Execução podem enviar mensagens (`sqs:SendMessage`).
- Duas subscriptions SQS → tópico com `RawMessageDelivery` e filtro por `MessageAttributes.evento`:
  - Billing: `orcamento.gerado`, `orcamento.aprovado`, `orcamento.reprovado`, `pagamento.confirmado`, `pagamento.recusado`.
  - Execução: `execucao.iniciada`, `execucao.concluida`, `execucao.falhou`.
- Policy IAM `oficina-os-service-messaging`: `sns:Publish` em `oficina-os-events` e consumo da fila principal.

## O que este root NÃO cria

Os tópicos SNS (`oficina-os-events`, `oficina-billing-events`, `oficina-execucao-events`)
pertencem ao root `mensageria/` do repo `oficina-infra-k8s` (ADR 0007). Este root só os referencia por ARN.

## Pré-requisito e ordem

1. Aplicar `mensageria/` no `oficina-infra-k8s` primeiro.
2. Obter os três ARNs dos tópicos (outputs daquele root) e usá-los nas variáveis `*_topic_arn` abaixo.
3. Só então aplicar este root.

## Variáveis

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `os_events_topic_arn` | sim | — | ARN do tópico `oficina-os-events` (publicado pelo os-service) |
| `billing_events_topic_arn` | sim | — | ARN do tópico `oficina-billing-events` (assinado pela fila) |
| `execucao_events_topic_arn` | sim | — | ARN do tópico `oficina-execucao-events` (assinado pela fila) |
| `aws_region` | não | `us-east-1` | Região; precisa ser a mesma do SNS/SQS da infra |
| `queue_name` | não | `oficina-os-queue` | Nome da fila principal |
| `dlq_name` | não | `oficina-os-dlq` | Nome da DLQ |
| `max_receive_count` | não | `3` | Recebimentos antes de ir para a DLQ |
| `visibility_timeout_seconds` | não | `30` | Visibility timeout da fila principal, em segundos |

Exemplo de `terraform/terraform.tfvars` (use os ARNs reais; o arquivo é ignorado pelo git via `*.tfvars`, não commite):

```hcl
os_events_topic_arn       = "arn:aws:sns:us-east-1:123456789012:oficina-os-events"
billing_events_topic_arn  = "arn:aws:sns:us-east-1:123456789012:oficina-billing-events"
execucao_events_topic_arn = "arn:aws:sns:us-east-1:123456789012:oficina-execucao-events"
```

## Comandos

Estado remoto em S3 com lock em DynamoDB; a configuração do backend fica em `backend.hcl`.

```bash
cd terraform
terraform init -backend-config=backend.hcl
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Checagem offline (sem credenciais AWS nem backend; é o que o job de CI `terraform-check` roda):

```bash
cd terraform
terraform init -backend=false && terraform fmt -check && terraform validate
```

## Verificação pós-apply

```bash
aws sqs get-queue-attributes --queue-url $(terraform output -raw queue_url) --attribute-names RedrivePolicy
```

A saída deve conter `maxReceiveCount` com valor `3` (ou o valor de `max_receive_count`).

## Avisos

- **Key do backend exclusiva:** `os-service/terraform.tfstate` é o state deste root. Não reutilize essa key em outro root nem em outro repo.
- **Paridade com LocalStack:** as filas, a policy, a redrive policy, os filtros e a visibility timeout devem ser mantidos iguais em `scripts/localstack/init-sns.sh`. Mudar um exige mudar o outro.
- **Sem IRSA por enquanto:** a policy `messaging_policy_arn` não está anexada a nenhuma role (o EKS ainda não voltou). Anexá-la fica para depois.
- **Secret do cluster:** o output `queue_url` alimenta o secret `SQS_QUEUE_URL`.
