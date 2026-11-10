import { Logger } from '@nestjs/common';

import { IncomingMessage } from '../../../../../shared/messaging/handlers/message-handler.interface';
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
} as unknown as ResultadoAplicacaoSaga;

const makeOrchestrator = (result: ResultadoAplicacaoSaga = encontrada) => {
  const aplicarEvento = jest.fn<
    Promise<ResultadoAplicacaoSaga>,
    [string, { osId?: string }, unknown?]
  >();
  aplicarEvento.mockResolvedValue(result);
  return {
    aplicarEvento,
    orchestrator: { aplicarEvento } as unknown as SagaOrchestrator,
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

    await handler.handle(msg(), tx);

    expect(aoCompensar).toHaveBeenCalledWith(encontrada, msg(), tx);
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
