#!/bin/bash
set -euo pipefail

# Idempotente: cada comando AWS aqui pode ser reexecutado sem falhar.

# Escapa uma string para ser embutida como valor JSON entre aspas.
json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Tópicos
awslocal sns create-topic --name oficina-os-events >/dev/null
BILLING_TOPIC_ARN=$(awslocal sns create-topic --name oficina-billing-events --query TopicArn --output text)
EXECUCAO_TOPIC_ARN=$(awslocal sns create-topic --name oficina-execucao-events --query TopicArn --output text)

# DLQ e fila principal
awslocal sqs create-queue --queue-name oficina-os-dlq >/dev/null
DLQ_URL=$(awslocal sqs get-queue-url --queue-name oficina-os-dlq --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name oficina-os-queue >/dev/null
QUEUE_URL=$(awslocal sqs get-queue-url --queue-name oficina-os-queue --query QueueUrl --output text)
QUEUE_ARN=$(awslocal sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Policy: somente os dois tópicos podem enviar mensagens para a fila.
POLICY='{"Version":"2012-10-17","Statement":[{"Sid":"AllowSnsSendMessage","Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"'"$QUEUE_ARN"'","Condition":{"ArnLike":{"aws:SourceArn":["'"$BILLING_TOPIC_ARN"'","'"$EXECUCAO_TOPIC_ARN"'"]}}}]}'
REDRIVE='{"deadLetterTargetArn":"'"$DLQ_ARN"'","maxReceiveCount":"3"}'

QUEUE_ATTRS='{"RedrivePolicy":"'"$(json_escape "$REDRIVE")"'","VisibilityTimeout":"30","Policy":"'"$(json_escape "$POLICY")"'"}'
awslocal sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "$QUEUE_ATTRS"

# Assinaturas SQS -> tópico (RawMessageDelivery + filtro por MessageAttributes.evento)
subscribe_queue() {
  local topic_arn=$1
  local filter=$2
  local sub_arn

  sub_arn=$(awslocal sns subscribe --topic-arn "$topic_arn" --protocol sqs \
    --notification-endpoint "$QUEUE_ARN" --query SubscriptionArn --output text)

  awslocal sns set-subscription-attributes --subscription-arn "$sub_arn" \
    --attribute-name RawMessageDelivery --attribute-value true
  awslocal sns set-subscription-attributes --subscription-arn "$sub_arn" \
    --attribute-name FilterPolicyScope --attribute-value MessageAttributes
  awslocal sns set-subscription-attributes --subscription-arn "$sub_arn" \
    --attribute-name FilterPolicy --attribute-value "$filter"
}

subscribe_queue "$BILLING_TOPIC_ARN" \
  '{"evento":["orcamento.gerado","orcamento.aprovado","orcamento.reprovado","pagamento.confirmado","pagamento.recusado"]}'
subscribe_queue "$EXECUCAO_TOPIC_ARN" \
  '{"evento":["execucao.iniciada","execucao.concluida","execucao.falhou"]}'
