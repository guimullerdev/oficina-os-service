import * as messageHandlerModule from './message-handler.interface';
import { IncomingMessage, MessageHandler } from './message-handler.interface';

describe('MessageHandler interface', () => {
  it('carrega o módulo de tipos sem erro', () => {
    expect(typeof messageHandlerModule).toBe('object');
  });

  it('aceita um objeto que implementa evento e handle', async () => {
    const received: IncomingMessage[] = [];
    const handler: MessageHandler = {
      evento: 'orcamento.gerado',
      handle: (message) => {
        received.push(message);
        return Promise.resolve();
      },
    };

    await handler.handle({
      messageId: 'm1',
      evento: handler.evento,
      payload: { id: 1 },
      correlationId: 'c1',
      traceparent: 't1',
    });

    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe('m1');
  });

  it('aceita IncomingMessage sem campos opcionais', () => {
    const message: IncomingMessage = {
      messageId: 'm2',
      evento: 'execucao.iniciada',
      payload: null,
    };

    expect(message.correlationId).toBeUndefined();
    expect(message.traceparent).toBeUndefined();
  });
});
