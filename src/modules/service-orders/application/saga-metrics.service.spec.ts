import {
  EVENTO_SAGA_PASSO_TRANSICAO,
  EVENTO_SAGA_STATUS,
  SagaMetrics,
} from './saga-metrics.service';

describe('SagaMetrics', () => {
  const logger = { info: jest.fn() };
  const metrics = new SagaMetrics(logger as any);

  beforeEach(() => jest.resetAllMocks());

  it('emite saga.passo.transicao', () => {
    metrics.passoTransicao({
      sagaId: 's-1',
      osId: 'os-1',
      passo: 'RESERVAR_ESTOQUE',
      ordem: 1,
      statusAnterior: null,
      statusNovo: 'PENDENTE',
      correlationId: 'req-1',
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        event: EVENTO_SAGA_PASSO_TRANSICAO,
        correlationId: 'req-1',
        sagaId: 's-1',
        osId: 'os-1',
        passo: 'RESERVAR_ESTOQUE',
        ordem: 1,
        statusAnterior: null,
        statusNovo: 'PENDENTE',
      },
      expect.any(String),
    );
    expect(EVENTO_SAGA_PASSO_TRANSICAO).toBe('saga.passo.transicao');
  });

  it('emite saga.status', () => {
    metrics.sagaStatus({
      sagaId: 's-1',
      osId: 'os-1',
      statusAnterior: 'EM_ANDAMENTO',
      statusNovo: 'CONCLUIDA',
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: EVENTO_SAGA_STATUS,
        statusAnterior: 'EM_ANDAMENTO',
        statusNovo: 'CONCLUIDA',
        correlationId: undefined,
      }),
      expect.any(String),
    );
    expect(EVENTO_SAGA_STATUS).toBe('saga.status');
  });

  it('não propaga erro do logger', () => {
    logger.info.mockImplementation(() => {
      throw new Error('log down');
    });

    expect(() =>
      metrics.sagaStatus({
        sagaId: 's-1',
        osId: 'os-1',
        statusAnterior: null,
        statusNovo: 'EM_ANDAMENTO',
      }),
    ).not.toThrow();
  });
});
