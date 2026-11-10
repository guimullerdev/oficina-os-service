import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  IncomingMessage,
  MessageHandler,
} from '../../../../../shared/messaging/handlers/message-handler.interface';
import { EVENTOS_SAGA } from '../saga-definicao';
import {
  ResultadoAplicacaoSaga,
  SagaOrchestrator,
} from '../saga-orchestrator.service';

/**
 * Ponto de extensão para compensações na OS (ex.: REPROVADA). Chamado dentro
 * da mesma transação, apenas quando a saga foi encontrada.
 */
export type AoCompensar = (
  resultado: Extract<ResultadoAplicacaoSaga, { encontrada: true }>,
  message: IncomingMessage,
  tx?: unknown,
) => Promise<void>;

export const EVENTOS_RECEBIDOS_PELA_SAGA: readonly string[] = [
  EVENTOS_SAGA.ORCAMENTO_GERADO,
  EVENTOS_SAGA.ORCAMENTO_APROVADO,
  EVENTOS_SAGA.ORCAMENTO_REPROVADO,
  EVENTOS_SAGA.EXECUCAO_INICIADA,
  EVENTOS_SAGA.EXECUCAO_CONCLUIDA,
  EVENTOS_SAGA.EXECUCAO_FALHOU,
  EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
  EVENTOS_SAGA.PAGAMENTO_RECUSADO,
];

const extrairOsId = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { osId, id } = payload as { osId?: unknown; id?: unknown };
  if (typeof osId === 'string') return osId;
  return typeof id === 'string' ? id : undefined;
};

/**
 * Aplica um evento recebido da fila à saga da OS, na transação do
 * processador idempotente. Erros propagam (a mensagem será reentregue).
 */
export class SagaEventHandler implements MessageHandler {
  private readonly logger = new Logger(SagaEventHandler.name);

  constructor(
    readonly evento: string,
    private readonly orchestrator: SagaOrchestrator,
    private readonly aoCompensar?: AoCompensar,
  ) {}

  async handle(message: IncomingMessage, tx?: unknown): Promise<void> {
    const resultado = await this.orchestrator.aplicarEvento(
      this.evento,
      {
        eventId: message.eventId ?? message.messageId,
        correlationId: message.correlationId,
        osId: extrairOsId(message.payload),
        payload: message.payload,
        traceparent: message.traceparent,
      },
      tx as Prisma.TransactionClient | undefined,
    );

    if (!resultado.encontrada) {
      this.logger.warn(
        `Evento ${this.evento} sem saga correspondente: ${resultado.motivo} (messageId=${message.messageId})`,
      );
      return;
    }

    this.logger.log(
      `Evento ${this.evento} aplicado à saga ${resultado.sagaId} (os=${resultado.osId}) decisao=${resultado.decisao.tipo}`,
    );
    await this.aoCompensar?.(resultado, message, tx);
  }
}

export const criarSagaEventHandlers = (
  orchestrator: SagaOrchestrator,
  aoCompensar?: AoCompensar,
): SagaEventHandler[] =>
  EVENTOS_RECEBIDOS_PELA_SAGA.map(
    (evento) => new SagaEventHandler(evento, orchestrator, aoCompensar),
  );
