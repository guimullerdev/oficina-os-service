import {
  OsStatusMetrics,
  EVENTO_TRANSICAO_STATUS,
} from './os-status-metrics.service';
import {
  OrdemDeServico,
  StatusOS,
} from '../domain/entities/service-orders.entity';

const makeOs = (historicoStatus: any[]) =>
  OrdemDeServico.restore({
    id: 'os-1',
    numero: 'OS-001',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    status: StatusOS.EM_DIAGNOSTICO,
    servicos: [],
    pecas: [],
    historicoStatus,
    dataAbertura: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe('OsStatusMetrics', () => {
  const logger = { info: jest.fn() };
  const metrics = new OsStatusMetrics(logger as any);

  beforeEach(() => jest.clearAllMocks());

  it('não emite evento quando o histórico tem menos de 2 entradas', () => {
    const os = makeOs([
      {
        id: 'h1',
        statusAnterior: null,
        statusNovo: StatusOS.RECEBIDA,
        data: new Date('2024-01-01T10:00:00Z'),
      },
    ]);

    metrics.registrarTransicao(os, 'req-1');

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('emite evento com a duração do último status', () => {
    const os = makeOs([
      {
        id: 'h1',
        statusAnterior: null,
        statusNovo: StatusOS.RECEBIDA,
        data: new Date('2024-01-01T10:00:00Z'),
      },
      {
        id: 'h2',
        statusAnterior: StatusOS.RECEBIDA,
        statusNovo: StatusOS.EM_DIAGNOSTICO,
        data: new Date('2024-01-01T10:01:30Z'),
      },
    ]);

    metrics.registrarTransicao(os, 'req-1');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: EVENTO_TRANSICAO_STATUS,
        correlationId: 'req-1',
        osId: 'os-1',
        duracaoSegundos: 90,
      }),
      expect.any(String),
    );
  });
});
