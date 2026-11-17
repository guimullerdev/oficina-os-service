import { Logger } from '@nestjs/common';

import {
  HandlerContext,
  IncomingMessage,
} from '../../../../../shared/messaging/handlers/message-handler.interface';
import { EVENTOS_SAGA } from '../saga-definicao';
import {
  ResultadoAplicacaoSaga,
  SagaOrchestrator,
} from '../saga-orchestrator.service';
import { criarSagaEventHandlers, SagaEventHandler } from './saga-event.handler';

const encontrada = {
  encontrada: true,
  sagaId: 's1',
  osId: 'os-1',
  decisao: { tipo: 'AVANCAR' },
  transicoes: {
    sagaId: 's1',
    osId: 'os-1',
    correlationId: 'c1',
    passos: [],
  },
} as unknown as ResultadoAplicacaoSaga;

const makeOrchestrator = (result: ResultadoAplicacaoSaga = encontrada) => {
  const aplicarEvento = jest.fn<
    Promise<ResultadoAplicacaoSaga>,
    [string, { osId?: string }, unknown?]
  >();
  aplicarEvento.mockResolvedValue(result);
  const emitirTransicoes = jest.fn();
  return {
    aplicarEvento,
    emitirTransicoes,
    orchestrator: {
      aplicarEvento,
      emitirTransicoes,
    } as unknown as SagaOrchestrator,
  };
};

const ctxFake = () => {
  const callbacks: Array<() => void | Promise<void>> = [];
  const ctx = {
    afterCommit: jest.fn((fn: () => void | Promise<void>) => {
      callbacks.push(fn);
    }),
  };
  return {
    ctx: ctx as HandlerContext,
    afterCommit: ctx.afterCommit,
    flush: async () => {
      for (const fn of callbacks) await fn();
    },
  };
};

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  messageId: 'm1',
  eventId: 'e1',
  evento: 'orcamento.gerado',
  payload: { osId: 'os-1', x: 1 },
  correlationId: 'c1',
  traceparent: 'tp',
  ...over,
});

describe('SagaEventHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('forwards the event, envelope and tx to the orchestrator', async () => {
    const { orchestrator, aplicarEvento } = makeOrchestrator();
    const tx = {};
    const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

    await handler.handle(msg(), tx);

    expect(aplicarEvento).toHaveBeenCalledWith(
      'orcamento.gerado',
      {
        eventId: 'e1',
        correlationId: 'c1',
        osId: 'os-1',
        payload: { osId: 'os-1', x: 1 },
        traceparent: 'tp',
      },
      tx,
    );
  });

  it('falls back to messageId and payload.id', async () => {
    const { orchestrator, aplicarEvento } = makeOrchestrator();
    const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

    await handler.handle(msg({ eventId: undefined, payload: { id: 'os-9' } }));

    expect(aplicarEvento.mock.calls[0][1]).toMatchObject({
      eventId: 'm1',
      osId: 'os-9',
    });
  });

  it('leaves osId undefined when payload has no string id', async () => {
    const { orchestrator, aplicarEvento } = makeOrchestrator();
    const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

    await handler.handle(msg({ payload: { osId: 5 } }));
    await handler.handle(msg({ payload: null }));

    expect(aplicarEvento.mock.calls[0][1].osId).toBeUndefined();
    expect(aplicarEvento.mock.calls[1][1].osId).toBeUndefined();
  });

  it('does not throw when the saga is not found', async () => {
    const { orchestrator } = makeOrchestrator({
      encontrada: false,
      motivo: 'sem saga',
    });
    const aoCompensar = jest.fn();
    const handler = new SagaEventHandler(
      'orcamento.gerado',
      orchestrator,
      aoCompensar,
    );

    await expect(handler.handle(msg())).resolves.toBeUndefined();
    expect(aoCompensar).not.toHaveBeenCalled();
  });

  it('hands the result and tx to aoCompensar when the saga is found', async () => {
    const { orchestrator } = makeOrchestrator();
    const aoCompensar = jest.fn().mockResolvedValue(undefined);
    const tx = {};
    const handler = new SagaEventHandler(
      'orcamento.gerado',
      orchestrator,
      aoCompensar,
    );

    const { ctx } = ctxFake();

    await handler.handle(msg(), tx, ctx);

    expect(aoCompensar).toHaveBeenCalledWith(encontrada, msg(), tx, ctx);
  });

  describe('aoAvancar', () => {
    it('hands (resultado, message, tx, ctx) to aoAvancar when the saga is found', async () => {
      const { orchestrator } = makeOrchestrator();
      const aoAvancar = jest.fn().mockResolvedValue(undefined);
      const tx = {};
      const { ctx } = ctxFake();
      const handler = new SagaEventHandler(
        'orcamento.aprovado',
        orchestrator,
        undefined,
        aoAvancar,
      );

      await handler.handle(msg(), tx, ctx);

      expect(aoAvancar).toHaveBeenCalledTimes(1);
      expect(aoAvancar).toHaveBeenCalledWith(encontrada, msg(), tx, ctx);
    });

    it('does not call aoAvancar when the saga is not found', async () => {
      const { orchestrator } = makeOrchestrator({
        encontrada: false,
        motivo: 'sem saga',
      });
      const aoAvancar = jest.fn();
      const handler = new SagaEventHandler(
        'orcamento.aprovado',
        orchestrator,
        undefined,
        aoAvancar,
      );

      await handler.handle(msg(), {});

      expect(aoAvancar).not.toHaveBeenCalled();
    });

    it('does not call aoAvancar when aplicarEvento rejects', async () => {
      const { orchestrator, aplicarEvento } = makeOrchestrator();
      aplicarEvento.mockRejectedValueOnce(new Error('boom'));
      const aoAvancar = jest.fn();
      const handler = new SagaEventHandler(
        'orcamento.aprovado',
        orchestrator,
        undefined,
        aoAvancar,
      );

      await expect(handler.handle(msg(), {})).rejects.toThrow('boom');
      expect(aoAvancar).not.toHaveBeenCalled();
    });

    it('calls aoAvancar after aoCompensar and propagates its error', async () => {
      const { orchestrator } = makeOrchestrator();
      const ordem: string[] = [];
      const aoCompensar = jest.fn(async () => {
        ordem.push('compensar');
      });
      const aoAvancar = jest.fn(async () => {
        ordem.push('avancar');
        throw new Error('avanco');
      });
      const handler = new SagaEventHandler(
        'orcamento.aprovado',
        orchestrator,
        aoCompensar,
        aoAvancar,
      );

      await expect(handler.handle(msg(), {})).rejects.toThrow('avanco');
      expect(ordem).toEqual(['compensar', 'avancar']);
    });

    it('wires aoAvancar into every created handler', async () => {
      const { orchestrator } = makeOrchestrator();
      const aoAvancar = jest.fn().mockResolvedValue(undefined);
      const handlers = criarSagaEventHandlers(
        orchestrator,
        undefined,
        aoAvancar,
      );

      await handlers[0].handle(msg());

      expect(aoAvancar).toHaveBeenCalledTimes(1);
    });
  });

  describe('emissão das métricas da saga', () => {
    const transicoes = (encontrada as { transicoes: unknown }).transicoes;

    it('com tx e ctx: registra afterCommit e só emite após o flush', async () => {
      const { orchestrator, emitirTransicoes } = makeOrchestrator();
      const { ctx, afterCommit, flush } = ctxFake();
      const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

      await handler.handle(msg(), {}, ctx);

      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(emitirTransicoes).not.toHaveBeenCalled();

      await flush();

      expect(emitirTransicoes).toHaveBeenCalledTimes(1);
      expect(emitirTransicoes).toHaveBeenCalledWith(transicoes);
    });

    it('sem tx: não registra afterCommit (o orquestrador já emitiu)', async () => {
      const { orchestrator, emitirTransicoes } = makeOrchestrator();
      const { ctx, afterCommit, flush } = ctxFake();
      const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

      await handler.handle(msg(), undefined, ctx);
      await flush();

      expect(afterCommit).not.toHaveBeenCalled();
      expect(emitirTransicoes).not.toHaveBeenCalled();
    });

    it('com tx e sem ctx: não lança e não emite', async () => {
      const { orchestrator, emitirTransicoes } = makeOrchestrator();
      const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

      await expect(handler.handle(msg(), {})).resolves.toBeUndefined();

      expect(emitirTransicoes).not.toHaveBeenCalled();
    });

    it('saga não encontrada: não registra afterCommit', async () => {
      const { orchestrator } = makeOrchestrator({
        encontrada: false,
        motivo: 'sem saga',
      });
      const { ctx, afterCommit } = ctxFake();
      const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

      await handler.handle(msg(), {}, ctx);

      expect(afterCommit).not.toHaveBeenCalled();
    });

    it('aplicarEvento rejeita: propaga e não registra afterCommit', async () => {
      const { orchestrator, aplicarEvento } = makeOrchestrator();
      aplicarEvento.mockRejectedValueOnce(new Error('boom'));
      const { ctx, afterCommit } = ctxFake();
      const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

      await expect(handler.handle(msg(), {}, ctx)).rejects.toThrow('boom');

      expect(afterCommit).not.toHaveBeenCalled();
    });

    it('aoCompensar rejeita: o erro propaga', async () => {
      const { orchestrator } = makeOrchestrator();
      const aoCompensar = jest.fn().mockRejectedValue(new Error('comp'));
      const { ctx } = ctxFake();
      const handler = new SagaEventHandler(
        'orcamento.gerado',
        orchestrator,
        aoCompensar,
      );

      await expect(handler.handle(msg(), {}, ctx)).rejects.toThrow('comp');
    });
  });

  it('propagates orchestrator errors so the message is redelivered', async () => {
    const { orchestrator, aplicarEvento } = makeOrchestrator();
    aplicarEvento.mockRejectedValueOnce(new Error('boom'));
    const handler = new SagaEventHandler('orcamento.gerado', orchestrator);

    await expect(handler.handle(msg())).rejects.toThrow('boom');
  });

  it('creates one handler per saga event', () => {
    const { orchestrator } = makeOrchestrator();
    const handlers = criarSagaEventHandlers(orchestrator);

    expect(handlers.map((h) => h.evento).sort()).toEqual(
      [
        EVENTOS_SAGA.ORCAMENTO_GERADO,
        EVENTOS_SAGA.ORCAMENTO_APROVADO,
        EVENTOS_SAGA.ORCAMENTO_REPROVADO,
        EVENTOS_SAGA.EXECUCAO_INICIADA,
        EVENTOS_SAGA.EXECUCAO_CONCLUIDA,
        EVENTOS_SAGA.EXECUCAO_FALHOU,
        EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
        EVENTOS_SAGA.PAGAMENTO_RECUSADO,
      ].sort(),
    );
  });

  it('wires aoCompensar into every created handler', async () => {
    const { orchestrator } = makeOrchestrator();
    const aoCompensar = jest.fn().mockResolvedValue(undefined);
    const [h] = criarSagaEventHandlers(orchestrator, aoCompensar);

    await h.handle(msg());

    expect(aoCompensar).toHaveBeenCalledTimes(1);
  });
});
