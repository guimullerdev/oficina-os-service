import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  IncomingMessage,
  MessageHandler,
} from '../handlers/message-handler.interface';

export type ProcessResult = 'processed' | 'duplicate';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Garante processamento idempotente de mensagens entregues "at least once".
 *
 * A chave de idempotência (`eventId`, ou `messageId` na ausência dele) é
 * inserida em `mensagens_processadas` na mesma transação em que o handler
 * executa: se o handler falhar, o insert é desfeito e o erro é relançado (a
 * mensagem não deve ser removida da fila e será reentregue). Uma entrega
 * repetida viola a unicidade de `event_id` e é descartada sem chamar o handler.
 */
@Injectable()
export class IdempotentProcessor {
  private readonly logger = new Logger(IdempotentProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(
    message: IncomingMessage,
    handler: MessageHandler,
  ): Promise<ProcessResult> {
    const eventId = message.eventId ?? message.messageId;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.mensagemProcessada.create({
          data: { eventId, evento: message.evento },
        });
        await handler.handle(message, tx);
      });
      return 'processed';
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        this.logger.warn(
          `Mensagem duplicada ignorada (eventId=${eventId}, evento=${message.evento})`,
        );
        return 'duplicate';
      }
      throw error;
    }
  }
}
