/**
 * Mensagem recebida de uma fila (ex.: SQS), já desserializada.
 */
export type IncomingMessage = {
  messageId: string;
  /** Identificador do evento (MessageAttribute do publisher); chave de idempotência. */
  eventId?: string;
  evento: string;
  payload: unknown;
  correlationId?: string;
  traceparent?: string;
};

/**
 * Contexto de execução de um handler. Permite registrar callbacks que só rodam
 * depois que a transação do handler for confirmada (commit) e a mensagem tiver
 * sido de fato processada — nunca em rollback, erro ou mensagem duplicada.
 * Erros de um callback são logados e não afetam a mensagem já confirmada.
 */
export interface HandlerContext {
  afterCommit(fn: () => void | Promise<void>): void;
}

/**
 * Trata mensagens de um evento específico. O registro é feito por `evento`.
 */
export interface MessageHandler {
  readonly evento: string;
  /**
   * `tx` é o cliente da transação em que a idempotência foi registrada; os
   * handlers que gravam no banco devem usá-lo para atomicidade.
   */
  handle(
    message: IncomingMessage,
    tx?: unknown,
    ctx?: HandlerContext,
  ): Promise<void>;
}
