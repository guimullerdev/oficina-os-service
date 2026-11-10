import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DomainEvent } from './domain-event';

/**
 * Grava eventos de domínio na tabela `outbox` usando o cliente transacional
 * recebido, de modo que o evento e o agregado sejam confirmados (ou
 * descartados) juntos. A publicação no broker é responsabilidade de outro
 * componente.
 */
@Injectable()
export class OutboxWriter {
  async append(
    tx: Prisma.TransactionClient,
    events: DomainEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    await tx.outbox.createMany({
      data: events.map((e) => ({
        evento: e.evento,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload as Prisma.InputJsonObject,
        correlationId: e.correlationId,
        traceparent: e.traceparent ?? null,
      })),
    });
  }
}
