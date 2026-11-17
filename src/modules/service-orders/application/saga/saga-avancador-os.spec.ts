import { Logger } from '@nestjs/common';

import {
  HandlerContext,
  IncomingMessage,
} from '../../../../shared/messaging/handlers/message-handler.interface';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import { IOrdemDeServicoRepositoryTransacional } from '../../domain/repositories/service-orders.repository.interface';
import { criarSagaEventHandlers } from './handlers/saga-event.handler';
import {
  OsAvancoConcorrenciaError,
  SagaAvancadorOs,
} from './saga-avancador-os';
import { SagaCompensador } from './saga-compensador';
import { EVENTOS_SAGA } from './saga-definicao';
import { TipoDecisao } from './saga-maquina';
import {
  ResultadoAplicacaoSaga,
  SagaOrchestrator,
} from './saga-orchestrator.service';

type Encontrada = Extract<ResultadoAplicacaoSaga, { encontrada: true }>;

const NOW = new Date('2024-01-01');

const osEm = (status: StatusOS): OrdemDeServico =>
  OrdemDeServico.restore({
    id: 'os-1',
    numero: 'OS-1',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    status,
    arquivada: false,
    servicos: [],
    pecas: [],
    historicoStatus: [],
    dataAbertura: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

const resultado = (tipo: TipoDecisao): Encontrada => ({
  encontrada: true,
  sagaId: 's1',
  osId: 'os-1',
  decisao: {
    tipo,
    passosAlterados: [],
    novoStatusSaga: 'EM_ANDAMENTO',
    comandos: [],
  },
  transicoes: {
    sagaId: 's1',
    osId: 'os-1',
    correlationId: 'corr-saga',
    passos: [],
  },
});

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

const msg = (evento: string, over: Partial<IncomingMessage> = {}) => ({
  messageId: 'm1',
  eventId: 'e1',
  evento,
  payload: { osId: 'os-1' },
  correlationId: 'corr-1',
  ...over,
});

const setup = (os: OrdemDeServico | null = null) => {
  const repo = {
    findByIdInTx: jest.fn().mockResolvedValue(os),
    updateStatusInTx: jest.fn().mockResolvedValue(true),
  };
  const metrics = { registrarTransicao: jest.fn() };
  const avancador = new SagaAvancadorOs(
    repo as IOrdemDeServicoRepositoryTransacional,
    metrics,
  );
  return { repo, metrics, avancador };
};

describe('SagaAvancadorOs', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each([
    {
      evento: EVENTOS_SAGA.ORCAMENTO_APROVADO,
      tipo: 'AVANCAR' as TipoDecisao,
      de: StatusOS.AGUARDANDO_APROVACAO,
      para: StatusOS.APROVADA,
    },
    {
      evento: EVENTOS_SAGA.EXECUCAO_INICIADA,
      tipo: 'PROGRESSO' as TipoDecisao,
      de: StatusOS.APROVADA,
      para: StatusOS.EM_EXECUCAO,
    },
    {
      evento: EVENTOS_SAGA.EXECUCAO_CONCLUIDA,
      tipo: 'AVANCAR' as TipoDecisao,
      de: StatusOS.EM_EXECUCAO,
      para: StatusOS.FINALIZADA,
    },
  ])('$evento', ({ evento, tipo, de, para }) => {
    it(`moves ${de} to ${para} in the given tx and emits the metric only after commit`, async () => {
      const { avancador, repo, metrics } = setup(osEm(de));
      const tx = { id: 'tx' };
      const { ctx, flush } = ctxFake();

      await avancador.aoAvancar(resultado(tipo), msg(evento), tx, ctx);

      expect(repo.findByIdInTx).toHaveBeenCalledWith('os-1', tx);
      expect(repo.updateStatusInTx).toHaveBeenCalledTimes(1);
      const [nova, esperado, txUsado] = repo.updateStatusInTx.mock.calls[0] as [
        OrdemDeServico,
        StatusOS,
        unknown,
      ];
      expect(nova.status).toBe(para);
      expect(nova.historicoStatus).toHaveLength(1);
      expect(nova.historicoStatus[0]).toMatchObject({
        statusAnterior: de,
        statusNovo: para,
      });
      expect(esperado).toBe(de);
      expect(txUsado).toBe(tx);
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();

      await flush();

      expect(metrics.registrarTransicao).toHaveBeenCalledTimes(1);
      expect(metrics.registrarTransicao).toHaveBeenCalledWith(nova, 'corr-1');
    });

    it('is a no-op when the OS is already in the target status', async () => {
      const { avancador, repo, metrics } = setup(osEm(para));
      const { ctx, afterCommit } = ctxFake();

      await expect(
        avancador.aoAvancar(resultado(tipo), msg(evento), {}, ctx),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(afterCommit).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('no-op'));
    });

    it('warns and skips when the OS is in an unrelated status (ENTREGUE)', async () => {
      const { avancador, repo, metrics } = setup(osEm(StatusOS.ENTREGUE));
      const { ctx, afterCommit } = ctxFake();

      await expect(
        avancador.aoAvancar(resultado(tipo), msg(evento), {}, ctx),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(afterCommit).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENTREGUE'));
    });

    it('does nothing when the saga ignored the event', async () => {
      const { avancador, repo } = setup(osEm(de));

      await avancador.aoAvancar(resultado('IGNORAR'), msg(evento), {});

      expect(repo.findByIdInTx).not.toHaveBeenCalled();
      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
    });

    it('throws when there is no transaction and does not touch the repository', async () => {
      const { avancador, repo } = setup(osEm(de));

      await expect(
        avancador.aoAvancar(resultado(tipo), msg(evento)),
      ).rejects.toThrow('exige a transação');

      expect(repo.findByIdInTx).not.toHaveBeenCalled();
      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
    });

    it('applies the update without ctx but emits no metric', async () => {
      const { avancador, repo, metrics } = setup(osEm(de));

      await avancador.aoAvancar(resultado(tipo), msg(evento), {});

      expect(repo.updateStatusInTx).toHaveBeenCalledTimes(1);
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });

    it('propagates a repository failure and registers nothing', async () => {
      const { avancador, repo, metrics } = setup(osEm(de));
      repo.updateStatusInTx.mockRejectedValue(new Error('db down'));
      const { ctx, afterCommit, flush } = ctxFake();

      await expect(
        avancador.aoAvancar(resultado(tipo), msg(evento), {}, ctx),
      ).rejects.toThrow('db down');
      await flush();

      expect(afterCommit).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });

    it('throws a concurrency error when the guarded write loses the race', async () => {
      const { avancador, repo, metrics } = setup(osEm(de));
      repo.updateStatusInTx.mockResolvedValue(false);
      const { ctx, afterCommit } = ctxFake();

      const erro = await avancador
        .aoAvancar(resultado(tipo), msg(evento), {}, ctx)
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(OsAvancoConcorrenciaError);
      expect(erro).toMatchObject({ osId: 'os-1', statusEsperado: de });
      expect(afterCommit).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  it('warns and skips when the OS does not exist', async () => {
    const { avancador, repo, metrics } = setup(null);

    await expect(
      avancador.aoAvancar(
        resultado('AVANCAR'),
        msg(EVENTOS_SAGA.ORCAMENTO_APROVADO),
        {},
      ),
    ).resolves.toBeUndefined();

    expect(repo.updateStatusInTx).not.toHaveBeenCalled();
    expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('não encontrada'),
    );
  });

  it.each([
    [EVENTOS_SAGA.ORCAMENTO_GERADO, 'AVANCAR'],
    [EVENTOS_SAGA.ORCAMENTO_REPROVADO, 'COMPENSAR'],
    [EVENTOS_SAGA.EXECUCAO_FALHOU, 'COMPENSAR'],
    [EVENTOS_SAGA.PAGAMENTO_CONFIRMADO, 'AVANCAR'],
    [EVENTOS_SAGA.PAGAMENTO_RECUSADO, 'COMPENSAR'],
  ] as Array<[string, TipoDecisao]>)(
    'does not move the OS for %s',
    async (evento, tipo) => {
      const { avancador, repo } = setup(osEm(StatusOS.APROVADA));

      await avancador.aoAvancar(resultado(tipo), msg(evento), {});

      expect(repo.findByIdInTx).not.toHaveBeenCalled();
      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
    },
  );

  it.each([
    [EVENTOS_SAGA.ORCAMENTO_APROVADO, 'PROGRESSO'],
    [EVENTOS_SAGA.EXECUCAO_INICIADA, 'AVANCAR'],
    [EVENTOS_SAGA.EXECUCAO_CONCLUIDA, 'PROGRESSO'],
  ] as Array<[string, TipoDecisao]>)(
    'does not move the OS for %s with an unexpected decision %s',
    async (evento, tipo) => {
      const { avancador, repo } = setup(osEm(StatusOS.APROVADA));

      await avancador.aoAvancar(resultado(tipo), msg(evento), {});

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
    },
  );

  describe('execucao.concluida com execucao.iniciada perdida', () => {
    it('applies APROVADA → EM_EXECUCAO → FINALIZADA in one write with full history', async () => {
      const { avancador, repo, metrics } = setup(osEm(StatusOS.APROVADA));
      const { ctx, flush } = ctxFake();

      await avancador.aoAvancar(
        resultado('AVANCAR'),
        msg(EVENTOS_SAGA.EXECUCAO_CONCLUIDA),
        {},
        ctx,
      );

      expect(repo.updateStatusInTx).toHaveBeenCalledTimes(1);
      const [nova, esperado] = repo.updateStatusInTx.mock.calls[0] as [
        OrdemDeServico,
        StatusOS,
      ];
      expect(esperado).toBe(StatusOS.APROVADA);
      expect(nova.status).toBe(StatusOS.FINALIZADA);
      expect(
        nova.historicoStatus.map((h) => [h.statusAnterior, h.statusNovo]),
      ).toEqual([
        [StatusOS.APROVADA, StatusOS.EM_EXECUCAO],
        [StatusOS.EM_EXECUCAO, StatusOS.FINALIZADA],
      ]);
      expect(nova.arquivada).toBe(true);
      expect(nova.dataFechamento).toBeInstanceOf(Date);
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();

      await flush();

      expect(metrics.registrarTransicao).toHaveBeenCalledTimes(2);
      const ultimos = metrics.registrarTransicao.mock.calls.map(
        ([o]: [OrdemDeServico]) => o.status,
      );
      expect(ultimos).toEqual([StatusOS.EM_EXECUCAO, StatusOS.FINALIZADA]);
    });
  });

  describe('via SagaEventHandler (happy path + execucao.falhou)', () => {
    it('iniciada then falhou: OS_VOLTA_APROVADA now takes effect', async () => {
      let os = osEm(StatusOS.APROVADA);
      const repo = {
        findByIdInTx: jest.fn(async () => os),
        updateStatusInTx: jest.fn(async (nova: OrdemDeServico) => {
          os = nova;
          return true;
        }),
      };
      const metrics = { registrarTransicao: jest.fn() };
      const r = repo as unknown as IOrdemDeServicoRepositoryTransacional;
      const decisoes: Record<string, Encontrada> = {
        [EVENTOS_SAGA.EXECUCAO_INICIADA]: resultado('PROGRESSO'),
        [EVENTOS_SAGA.EXECUCAO_FALHOU]: {
          ...resultado('COMPENSAR'),
          decisao: {
            ...resultado('COMPENSAR').decisao,
            compensacao: 'OS_VOLTA_APROVADA',
          },
        },
      };
      const orchestrator = {
        aplicarEvento: jest.fn(async (evento: string) => decisoes[evento]),
        emitirTransicoes: jest.fn(),
      } as unknown as SagaOrchestrator;
      const handlers = criarSagaEventHandlers(
        orchestrator,
        new SagaCompensador(r, metrics).aoCompensar,
        new SagaAvancadorOs(r, metrics).aoAvancar,
      );
      const porEvento = (e: string) => handlers.find((h) => h.evento === e)!;
      const { ctx, flush } = ctxFake();

      await porEvento(EVENTOS_SAGA.EXECUCAO_INICIADA).handle(
        msg(EVENTOS_SAGA.EXECUCAO_INICIADA),
        {},
        ctx,
      );
      expect(os.status).toBe(StatusOS.EM_EXECUCAO);

      await porEvento(EVENTOS_SAGA.EXECUCAO_FALHOU).handle(
        msg(EVENTOS_SAGA.EXECUCAO_FALHOU),
        {},
        ctx,
      );
      expect(os.status).toBe(StatusOS.APROVADA);

      await flush();
      expect(metrics.registrarTransicao).toHaveBeenCalledTimes(2);
    });
  });
});
