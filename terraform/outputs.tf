output "queue_url" {
  description = "URL da fila principal do os-service"
  value       = aws_sqs_queue.main.url
}

output "queue_arn" {
  description = "ARN da fila principal do os-service"
  value       = aws_sqs_queue.main.arn
}

output "dlq_url" {
  description = "URL da DLQ do os-service"
  value       = aws_sqs_queue.dlq.url
}

output "dlq_arn" {
  description = "ARN da DLQ do os-service"
  value       = aws_sqs_queue.dlq.arn
}

output "messaging_policy_arn" {
  description = "ARN da policy IAM de mensageria (sns:Publish + consumo SQS), a ser anexada a uma role"
  value       = aws_iam_policy.messaging.arn
}

output "billing_subscription_arn" {
  description = "ARN da assinatura da fila no tópico de Billing"
  value       = aws_sns_topic_subscription.billing.arn
}

output "execucao_subscription_arn" {
  description = "ARN da assinatura da fila no tópico de Execução"
  value       = aws_sns_topic_subscription.execucao.arn
}
