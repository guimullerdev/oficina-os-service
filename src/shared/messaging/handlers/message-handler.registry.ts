import { Injectable } from '@nestjs/common';

import { MessageHandler } from './message-handler.interface';

/**
 * Lançado quando não há handler registrado para o evento recebido.
 */
export class UnknownEventError extends Error {
  readonly evento: string;

  constructor(evento: string) {
    super(`Nenhum handler registrado para o evento ${evento}`);
    this.name = 'UnknownEventError';
    this.evento = evento;
  }
}

/**
 * Mapeia o nome do `evento` ao handler responsável por ele.
 */
@Injectable()
export class MessageHandlerRegistry {
  private readonly handlers = new Map<string, MessageHandler>();

  register(handler: MessageHandler): void {
    if (this.handlers.has(handler.evento)) {
      throw new Error(`Handler duplicado para o evento ${handler.evento}`);
    }
    this.handlers.set(handler.evento, handler);
  }

  resolve(evento: string): MessageHandler {
    const handler = this.handlers.get(evento);
    if (!handler) {
      throw new UnknownEventError(evento);
    }
    return handler;
  }

  has(evento: string): boolean {
    return this.handlers.has(evento);
  }
}
