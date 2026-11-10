import { Logger } from '@nestjs/common';

import { IncomingMessage, MessageHandler } from './message-handler.interface';

export const EVENTO_ORCAMENTO_GERADO = 'orcamento.gerado';
export const EVENTO_ORCAMENTO_APROVADO = 'orcamento.aprovado';
export const EVENTO_ORCAMENTO_REPROVADO = 'orcamento.reprovado';
export const EVENTO_EXECUCAO_INICIADA = 'execucao.iniciada';
export const EVENTO_EXECUCAO_CONCLUIDA = 'execucao.concluida';
export const EVENTO_EXECUCAO_FALHOU = 'execucao.falhou';

/**
 * Handler provisório: apenas registra o recebimento do evento.
 * Será substituído pelos handlers reais na Fase 5.
 */
class NoopMessageHandler implements MessageHandler {
  private readonly logger = new Logger(NoopMessageHandler.name);

  constructor(readonly evento: string) {}

  handle(message: IncomingMessage): Promise<void> {
    this.logger.log(
      `Evento ${message.evento} recebido (no-op) messageId=${message.messageId}`,
    );
    return Promise.resolve();
  }
}

export const NOOP_HANDLERS: readonly MessageHandler[] = [
  EVENTO_ORCAMENTO_GERADO,
  EVENTO_ORCAMENTO_APROVADO,
  EVENTO_ORCAMENTO_REPROVADO,
  EVENTO_EXECUCAO_INICIADA,
  EVENTO_EXECUCAO_CONCLUIDA,
  EVENTO_EXECUCAO_FALHOU,
].map((evento) => new NoopMessageHandler(evento));
