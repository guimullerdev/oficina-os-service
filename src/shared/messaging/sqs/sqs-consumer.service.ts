import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { IncomingMessage } from '../handlers/message-handler.interface';
import { MessageHandlerRegistry } from '../handlers/message-handler.registry';
import { IdempotentProcessor } from '../idempotency/idempotent-processor';

const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_MESSAGES = 10;
// Limite do SQS para MaxNumberOfMessages.
const SQS_MAX_MESSAGES_LIMIT = 10;
const RECEIVE_BACKOFF_MS = 2000;

const positiveInt = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Consome a fila SQS (subscription com raw delivery) e despacha cada mensagem
 * ao handler do `evento`, via `IdempotentProcessor`.
 *
 * A mensagem só é removida da fila após sucesso (inclusive duplicata). Qualquer
 * falha (JSON inválido, `evento` ausente, evento desconhecido, erro do handler)
 * é logada e a mensagem NÃO é removida: ela reaparece após o visibility timeout
 * e, depois de 3 recebimentos, a `redrive_policy` a move para a DLQ.
 *
 * Com várias réplicas consumindo a mesma fila Standard, uma mesma mensagem pode
 * ser entregue mais de uma vez; a idempotência por `eventId` absorve isso.
 */
@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private running = false;
  private abortController?: AbortController;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: ConfigService,
    private readonly registry: MessageHandlerRegistry,
    private readonly processor: IdempotentProcessor,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('SQS_CONSUMER_ENABLED') !== 'true') {
      this.logger.log('SQS consumer disabled');
      return;
    }
    if (!this.queueUrl) {
      this.logger.error(
        'SQS_QUEUE_URL is not set; SQS consumer will not start',
      );
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.loop = this.run(this.abortController.signal);
    this.logger.log('SQS consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    await this.loop;
    this.loop = undefined;
  }

  /**
   * Faz um long poll e processa o lote. Público para ser testado sem o loop.
   * Retorna a quantidade de mensagens recebidas.
   */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const { Messages } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        WaitTimeSeconds: positiveInt(
          this.config.get('SQS_WAIT_TIME_SECONDS'),
          DEFAULT_WAIT_TIME_SECONDS,
        ),
        VisibilityTimeout: positiveInt(
          this.config.get('SQS_VISIBILITY_TIMEOUT_SECONDS'),
          DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
        ),
        MaxNumberOfMessages: Math.min(
          positiveInt(
            this.config.get('SQS_MAX_MESSAGES'),
            DEFAULT_MAX_MESSAGES,
          ),
          SQS_MAX_MESSAGES_LIMIT,
        ),
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: signal },
    );

    const messages = Messages ?? [];
    for (const message of messages) {
      await this.handleMessage(message);
    }
    return messages.length;
  }

  private get queueUrl(): string | undefined {
    return this.config.get<string>('SQS_QUEUE_URL');
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(signal);
      } catch (err) {
        if (!this.running) break;
        this.logger.error(`SQS receive failed: ${errorMessage(err)}`);
        await this.sleep(RECEIVE_BACKOFF_MS, signal);
      }
    }
  }

  /** Espera `ms`, mas acorda antes se o sinal for abortado. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    const messageId = message.MessageId ?? 'unknown';
    let evento: string | undefined;
    try {
      const incoming = this.toIncoming(message);
      evento = incoming.evento;
      const handler = this.registry.resolve(incoming.evento);
      await this.processor.process(incoming, handler);
    } catch (err) {
      this.logger.error(
        `Failed to process SQS message (messageId=${messageId}, evento=${evento ?? 'unknown'}): ${errorMessage(err)}`,
      );
      return;
    }

    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (err) {
      // A mensagem volta após o visibility timeout e será descartada como
      // duplicata pela idempotência.
      this.logger.error(
        `Failed to delete SQS message (messageId=${messageId}, evento=${evento}): ${errorMessage(err)}`,
      );
    }
  }

  private toIncoming(message: Message): IncomingMessage {
    const attr = (name: string): string | undefined =>
      message.MessageAttributes?.[name]?.StringValue;

    const evento = attr('evento');
    if (!evento) {
      throw new Error('Message attribute "evento" is missing');
    }

    return {
      messageId: message.MessageId ?? '',
      evento,
      eventId: attr('eventId'),
      correlationId: attr('correlationId'),
      traceparent: attr('traceparent'),
      payload: JSON.parse(message.Body ?? '') as unknown,
    };
  }
}
