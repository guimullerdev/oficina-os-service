variable "aws_region" {
  description = "Região AWS — precisa ser a mesma do SNS/SQS e do restante da infra da oficina"
  type        = string
  default     = "us-east-1"
}

variable "os_events_topic_arn" {
  description = "ARN do tópico SNS oficina-os-events (publicado pelo os-service)"
  type        = string

  validation {
    condition     = can(regex("^arn:aws:sns:", var.os_events_topic_arn))
    error_message = "os_events_topic_arn deve ser um ARN SNS (começa com arn:aws:sns:)."
  }
}

variable "billing_events_topic_arn" {
  description = "ARN do tópico SNS oficina-billing-events (assinado pela fila do os-service)"
  type        = string

  validation {
    condition     = can(regex("^arn:aws:sns:", var.billing_events_topic_arn))
    error_message = "billing_events_topic_arn deve ser um ARN SNS (começa com arn:aws:sns:)."
  }
}

variable "execucao_events_topic_arn" {
  description = "ARN do tópico SNS oficina-execucao-events (assinado pela fila do os-service)"
  type        = string

  validation {
    condition     = can(regex("^arn:aws:sns:", var.execucao_events_topic_arn))
    error_message = "execucao_events_topic_arn deve ser um ARN SNS (começa com arn:aws:sns:)."
  }
}

variable "queue_name" {
  description = "Nome da fila SQS principal do os-service"
  type        = string
  default     = "oficina-os-queue"
}

variable "dlq_name" {
  description = "Nome da dead-letter queue do os-service"
  type        = string
  default     = "oficina-os-dlq"
}

variable "max_receive_count" {
  description = "Número de recebimentos antes de a mensagem ir para a DLQ (redrive policy)"
  type        = number
  default     = 3
}

variable "visibility_timeout_seconds" {
  description = "Visibility timeout da fila principal, em segundos"
  type        = number
  default     = 30
}
