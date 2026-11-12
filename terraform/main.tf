# Recursos de mensageria do os-service. Paridade com scripts/localstack/init-sns.sh.

resource "aws_sqs_queue" "dlq" {
  name = var.dlq_name
}

resource "aws_sqs_queue" "main" {
  name                       = var.queue_name
  visibility_timeout_seconds = var.visibility_timeout_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main.arn]
  })
}

# Somente os tópicos de Billing e Execução podem enviar mensagens para a fila.
data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "AllowSnsSendMessage"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.main.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        var.billing_events_topic_arn,
        var.execucao_events_topic_arn,
      ]
    }
  }
}

resource "aws_sqs_queue_policy" "main" {
  queue_url = aws_sqs_queue.main.id
  policy    = data.aws_iam_policy_document.queue.json
}

# Assinaturas SQS -> tópico (raw delivery + filtro por MessageAttributes.evento)
resource "aws_sns_topic_subscription" "billing" {
  topic_arn            = var.billing_events_topic_arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.main.arn
  raw_message_delivery = true
  filter_policy_scope  = "MessageAttributes"

  filter_policy = jsonencode({
    evento = [
      "orcamento.gerado",
      "orcamento.aprovado",
      "orcamento.reprovado",
      "pagamento.confirmado",
      "pagamento.recusado",
    ]
  })

  depends_on = [aws_sqs_queue_policy.main]
}

resource "aws_sns_topic_subscription" "execucao" {
  topic_arn            = var.execucao_events_topic_arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.main.arn
  raw_message_delivery = true
  filter_policy_scope  = "MessageAttributes"

  filter_policy = jsonencode({
    evento = [
      "execucao.iniciada",
      "execucao.concluida",
      "execucao.falhou",
    ]
  })

  depends_on = [aws_sqs_queue_policy.main]
}

# Policy IAM de mensageria: publica em os-events e consome a fila do os-service.
data "aws_iam_policy_document" "messaging" {
  statement {
    sid       = "PublishOsEvents"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [var.os_events_topic_arn]
  }

  statement {
    sid    = "ConsumeOsQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.main.arn]
  }
}

resource "aws_iam_policy" "messaging" {
  name        = "oficina-os-service-messaging"
  description = "Publicar em oficina-os-events e consumir a fila do os-service"
  policy      = data.aws_iam_policy_document.messaging.json
}

# Credencial do pod. Sem IRSA (o cluster é recriado a cada janela), o pod usa a
# chave estática de um usuário que só tem a policy acima: publicar em
# oficina-os-events e consumir a fila. A chave NÃO é criada aqui, para o segredo
# não ir parar no state: `aws iam create-access-key` e `gh secret set`
# (POD_AWS_ACCESS_KEY_ID / POD_AWS_SECRET_ACCESS_KEY), ver o README deste root.
resource "aws_iam_user" "service" {
  name = "oficina-os-service"
}

resource "aws_iam_user_policy_attachment" "service_messaging" {
  user       = aws_iam_user.service.name
  policy_arn = aws_iam_policy.messaging.arn
}
