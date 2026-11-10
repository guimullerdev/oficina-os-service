import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageAttributeValue,
  PublishCommand,
  SNSClient,
} from '@aws-sdk/client-sns';

import { PrismaService } from '../../prisma/prisma.service';

interface OutboxRow {
  id: string;
  evento: string;
  payload: unknown;
  correlationId: string;
  traceparent: string | null;
}

export interface PublishBatchResult {
  published: number;
  failed: number;
}

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_ERROR_LENGTH = 1000;
// A transação segura os locks enquanto publica o lote inteiro; o default do
// Prisma (5s) é curto para N chamadas sequenciais ao SNS.
const TRANSACTION_TIMEOUT_MS = 60_000;

const positiveInt = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const stringAttr = (value: string): MessageAttributeValue => ({
  DataType: 'String',
  StringValue: value,
});

/**
 * Publica periodicamente as linhas pendentes da tabela `outbox` no tópico SNS.
 *
 * Semântica at-least-once: a linha só recebe `published_at` depois que o SNS
 * confirmou o publish, e tudo ocorre na mesma transação. Se a transação falhar
 * depois do publish (ex.: queda do banco), a linha volta a ficar pendente e
 * o evento é publicado de novo. Consumidores devem deduplicar pelo atributo
 * `eventId` (id da linha do outbox).
 *
 * `FOR UPDATE SKIP LOCKED` permite que várias réplicas rodem o publisher ao
 * mesmo tempo sem pegar as mesmas linhas.
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sns: SNSClient,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('OUTBOX_PUBLISHER_ENABLED') !== 'true') {
      this.logger.log('Outbox publisher disabled');
      return;
    }
    if (!this.topicArn) {
      this.logger.error(
        'SNS_TOPIC_ARN is not set; outbox publisher will not start',
      );
      return;
    }

    const interval = positiveInt(
      this.config.get('OUTBOX_PUBLISH_INTERVAL_MS'),
      DEFAULT_INTERVAL_MS,
    );
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.logger.log(`Outbox publisher started (every ${interval}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Publica um lote. Público para ser testado sem o timer. */
  async publishBatch(): Promise<PublishBatchResult> {
    const topicArn = this.topicArn;
    const batchSize = positiveInt(
      this.config.get('OUTBOX_BATCH_SIZE'),
      DEFAULT_BATCH_SIZE,
    );

    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, evento, payload, correlation_id AS "correlationId", traceparent
          FROM outbox
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;

        const result: PublishBatchResult = { published: 0, failed: 0 };

        for (const row of rows) {
          try {
            await this.sns.send(
              new PublishCommand({
                TopicArn: topicArn,
                Message: JSON.stringify(row.payload),
                MessageAttributes: this.attributesFor(row),
              }),
            );
            await tx.outbox.update({
              where: { id: row.id },
              data: { publishedAt: new Date() },
            });
            result.published++;
          } catch (err) {
            result.failed++;
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Failed to publish outbox ${row.id}: ${message}`);
            await tx.outbox.update({
              where: { id: row.id },
              data: {
                tentativas: { increment: 1 },
                ultimoErro: message.slice(0, MAX_ERROR_LENGTH),
              },
            });
          }
        }

        return result;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private get topicArn(): string {
    return this.config.get<string>('SNS_TOPIC_ARN') ?? '';
  }

  private attributesFor(row: OutboxRow): Record<string, MessageAttributeValue> {
    const attributes: Record<string, MessageAttributeValue> = {
      evento: stringAttr(row.evento),
      eventId: stringAttr(row.id),
    };
    if (row.correlationId) {
      attributes.correlationId = stringAttr(row.correlationId);
    }
    if (row.traceparent) {
      attributes.traceparent = stringAttr(row.traceparent);
    }
    return attributes;
  }

  private async tick(): Promise<void> {
    // Evita sobreposição se um lote demorar mais que o intervalo.
    if (this.running) return;
    this.running = true;
    try {
      await this.publishBatch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Outbox batch failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
