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
 * Trata mensagens de um evento específico. O registro é feito por `evento`.
 */
export interface MessageHandler {
  readonly evento: string;
  handle(message: IncomingMessage): Promise<void>;
}
