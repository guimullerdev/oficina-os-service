import { of, lastValueFrom } from 'rxjs';

import { OsStatusMetricsInterceptor } from './os-status-metrics.interceptor';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';

const makeOs = () =>
  OrdemDeServico.restore({
    id: 'os-1',
    numero: 'OS-001',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    status: StatusOS.RECEBIDA,
    servicos: [],
    pecas: [],
    historicoStatus: [],
    dataAbertura: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const makeContext = () =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }) }),
  }) as any;

describe('OsStatusMetricsInterceptor', () => {
  const metrics = { registrarTransicao: jest.fn() };
  const interceptor = new OsStatusMetricsInterceptor(metrics as any);

  beforeEach(() => jest.clearAllMocks());

  it('registra a transição quando a resposta é uma OrdemDeServico', async () => {
    const os = makeOs();

    const result = await lastValueFrom(
      interceptor.intercept(makeContext(), { handle: () => of(os) }),
    );

    expect(result).toBe(os);
    expect(metrics.registrarTransicao).toHaveBeenCalledWith(os, 'req-1');
  });

  it('ignora respostas que não são OrdemDeServico', async () => {
    await lastValueFrom(
      interceptor.intercept(makeContext(), { handle: () => of({}) }),
    );

    expect(metrics.registrarTransicao).not.toHaveBeenCalled();
  });
});
