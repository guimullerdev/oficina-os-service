import { Injectable } from '@nestjs/common';
import { StatusPassoSaga, StatusSaga } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

/** Evento de transição de status de um passo da saga. */
export const EVENTO_SAGA_PASSO_TRANSICAO = 'saga.passo.transicao';

/** Evento de transição de status da saga. */
export const EVENTO_SAGA_STATUS = 'saga.status';

export type PassoTransicaoInput = {
  sagaId: string;
  osId: string;
  passo: string;
  ordem: number;
  /** null na criação do passo. */
  statusAnterior: StatusPassoSaga | null;
  statusNovo: StatusPassoSaga;
  correlationId?: string;
};

export type SagaStatusInput = {
  sagaId: string;
  osId: string;
  /** null na criação da saga. */
  statusAnterior: StatusSaga | null;
  statusNovo: StatusSaga;
  correlationId?: string;
};

/**
 * Emite as métricas da saga como logs estruturados (campo `event`, igual ao
 * `os.status.transicao`), consultáveis no New Relic via
 * `FROM Log WHERE event = 'saga.status'`.
 *
 * Falha de log nunca propaga para quem chama: métrica não pode derrubar a saga.
 */
@Injectable()
export class SagaMetrics {
  constructor(private readonly logger: PinoLogger) {}

  passoTransicao(input: PassoTransicaoInput): void {
    this.emitir(
      {
        event: EVENTO_SAGA_PASSO_TRANSICAO,
        correlationId: input.correlationId,
        sagaId: input.sagaId,
        osId: input.osId,
        passo: input.passo,
        ordem: input.ordem,
        statusAnterior: input.statusAnterior,
        statusNovo: input.statusNovo,
      },
      'Transição de status do passo da saga',
    );
  }

  sagaStatus(input: SagaStatusInput): void {
    this.emitir(
      {
        event: EVENTO_SAGA_STATUS,
        correlationId: input.correlationId,
        sagaId: input.sagaId,
        osId: input.osId,
        statusAnterior: input.statusAnterior,
        statusNovo: input.statusNovo,
      },
      'Transição de status da saga',
    );
  }

  private emitir(campos: Record<string, unknown>, mensagem: string): void {
    try {
      this.logger.info(campos, mensagem);
    } catch {
      // Falha de observabilidade não deve afetar o fluxo da saga.
    }
  }
}
