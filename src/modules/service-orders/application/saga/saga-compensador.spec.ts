import { Logger } from '@nestjs/common';

import { IncomingMessage } from '../../../../shared/messaging/handlers/message-handler.interface';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import { IOrdemDeServicoRepositoryTransacional } from '../../domain/repositories/service-orders.repository.interface';
import { criarSagaEventHandlers } from './handlers/saga-event.handler';
import { Compensacao } from './saga-definicao';
import {
  OsCompensacaoConcorrenciaError,
  SagaCompensador,
} from './saga-compensador';
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

const resultado = (
  tipo: TipoDecisao,
  compensacao?: Compensacao,
): Encontrada => ({
  encontrada: true,
  sagaId: 's1',
  osId: 'os-1',
  decisao: {
    tipo,
    passosAlterados: [],
    novoStatusSaga: 'COMPENSADA',
    comandos: [],
    compensacao,
  },
});

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  messageId: 'm1',
  eventId: 'e1',
  evento: 'orcamento.reprovado',
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
  const compensador = new SagaCompensador(
    repo as IOrdemDeServicoRepositoryTransacional,
    metrics,
  );
  return { repo, metrics, compensador };
};

describe('SagaCompensador', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('OS_REPROVADA', () => {
    it('moves AGUARDANDO_APROVACAO to REPROVADA in the given tx and emits the metric', async () => {
      const { compensador, repo, metrics } = setup(
        osEm(StatusOS.AGUARDANDO_APROVACAO),
      );
      const tx = { id: 'tx' };

      await compensador.aoCompensar(
        resultado('COMPENSAR', 'OS_REPROVADA'),
        msg(),
        tx,
      );

      expect(repo.findByIdInTx).toHaveBeenCalledWith('os-1', tx);
      expect(repo.updateStatusInTx).toHaveBeenCalledTimes(1);
      const [compensada, esperado, txUsado] = repo.updateStatusInTx.mock
        .calls[0] as [OrdemDeServico, StatusOS, unknown];
      expect(compensada.status).toBe(StatusOS.REPROVADA);
      expect(esperado).toBe(StatusOS.AGUARDANDO_APROVACAO);
      expect(txUsado).toBe(tx);
      expect(metrics.registrarTransicao).toHaveBeenCalledWith(
        compensada,
        'corr-1',
      );
    });

    it('is a no-op when the OS is already REPROVADA', async () => {
      const { compensador, repo, metrics } = setup(osEm(StatusOS.REPROVADA));

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_REPROVADA'),
          msg(),
          {},
        ),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    });

    it('warns and resolves when the OS is in another status (APROVADA)', async () => {
      const { compensador, repo, metrics } = setup(osEm(StatusOS.APROVADA));

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_REPROVADA'),
          msg(),
          {},
        ),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('APROVADA'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AGUARDANDO_APROVACAO'),
      );
    });

    it('throws when there is no transaction and does not touch the repository', async () => {
      const { compensador, repo, metrics } = setup(
        osEm(StatusOS.AGUARDANDO_APROVACAO),
      );

      await expect(
        compensador.aoCompensar(resultado('COMPENSAR', 'OS_REPROVADA'), msg()),
      ).rejects.toThrow('exige a transação');

      expect(repo.findByIdInTx).not.toHaveBeenCalled();
      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  describe('OS_VOLTA_APROVADA', () => {
    it('moves EM_EXECUCAO back to APROVADA in the given tx and emits the metric', async () => {
      const { compensador, repo, metrics } = setup(osEm(StatusOS.EM_EXECUCAO));
      const tx = { id: 'tx' };

      await compensador.aoCompensar(
        resultado('COMPENSAR', 'OS_VOLTA_APROVADA'),
        msg({ evento: 'execucao.falhou' }),
        tx,
      );

      const [compensada, esperado, txUsado] = repo.updateStatusInTx.mock
        .calls[0] as [OrdemDeServico, StatusOS, unknown];
      expect(compensada.status).toBe(StatusOS.APROVADA);
      expect(esperado).toBe(StatusOS.EM_EXECUCAO);
      expect(txUsado).toBe(tx);
      expect(metrics.registrarTransicao).toHaveBeenCalledWith(
        compensada,
        'corr-1',
      );
    });

    it('is a no-op when the OS is already APROVADA', async () => {
      const { compensador, repo, metrics } = setup(osEm(StatusOS.APROVADA));

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_VOLTA_APROVADA'),
          msg(),
          {},
        ),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });

    it('warns and resolves when the OS is in another status (FINALIZADA)', async () => {
      const { compensador, repo, metrics } = setup(osEm(StatusOS.FINALIZADA));

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_VOLTA_APROVADA'),
          msg(),
          {},
        ),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('FINALIZADA'));
    });
  });

  describe('PAGAMENTO_PENDENTE', () => {
    it.each([[{}], [undefined]])(
      'only warns, never touching repo or metrics (tx=%p)',
      async (tx) => {
        const { compensador, repo, metrics } = setup(
          osEm(StatusOS.EM_EXECUCAO),
        );

        await expect(
          compensador.aoCompensar(
            resultado('COMPENSAR', 'PAGAMENTO_PENDENTE'),
            msg({ messageId: 'm-pag' }),
            tx,
          ),
        ).resolves.toBeUndefined();

        expect(repo.findByIdInTx).not.toHaveBeenCalled();
        expect(repo.updateStatusInTx).not.toHaveBeenCalled();
        expect(metrics.registrarTransicao).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('messageId=m-pag'),
        );
      },
    );
  });

  describe('decisions that do not compensate', () => {
    it.each<TipoDecisao>(['AVANCAR', 'PROGRESSO', 'IGNORAR'])(
      'does nothing for tipo %s',
      async (tipo) => {
        const { compensador, repo, metrics } = setup(
          osEm(StatusOS.AGUARDANDO_APROVACAO),
        );

        await compensador.aoCompensar(
          resultado(tipo, 'OS_REPROVADA'),
          msg(),
          {},
        );

        expect(repo.findByIdInTx).not.toHaveBeenCalled();
        expect(repo.updateStatusInTx).not.toHaveBeenCalled();
        expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      },
    );

    it('does nothing for COMPENSAR without a compensation (timeout)', async () => {
      const { compensador, repo, metrics } = setup(
        osEm(StatusOS.AGUARDANDO_APROVACAO),
      );

      await compensador.aoCompensar(resultado('COMPENSAR'), msg());

      expect(repo.findByIdInTx).not.toHaveBeenCalled();
      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('warns and resolves when the OS does not exist', async () => {
      const { compensador, repo, metrics } = setup(null);

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_REPROVADA'),
          msg(),
          {},
        ),
      ).resolves.toBeUndefined();

      expect(repo.updateStatusInTx).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('os-1'));
    });

    it('throws OsCompensacaoConcorrenciaError when the guarded update loses the race', async () => {
      const { compensador, repo, metrics } = setup(
        osEm(StatusOS.AGUARDANDO_APROVACAO),
      );
      repo.updateStatusInTx.mockResolvedValue(false);

      const erro = await compensador
        .aoCompensar(resultado('COMPENSAR', 'OS_REPROVADA'), msg(), {})
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(OsCompensacaoConcorrenciaError);
      expect(erro).toMatchObject({
        name: 'OsCompensacaoConcorrenciaError',
        osId: 'os-1',
        statusEsperado: StatusOS.AGUARDANDO_APROVACAO,
      });
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });

    it('propagates repository read errors', async () => {
      const { compensador, repo, metrics } = setup();
      repo.findByIdInTx.mockRejectedValue(new Error('db down'));

      await expect(
        compensador.aoCompensar(
          resultado('COMPENSAR', 'OS_REPROVADA'),
          msg(),
          {},
        ),
      ).rejects.toThrow('db down');

      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  it('works when aoCompensar is detached from the instance', async () => {
    const { compensador, repo } = setup(osEm(StatusOS.AGUARDANDO_APROVACAO));
    const { aoCompensar } = compensador;

    await aoCompensar(resultado('COMPENSAR', 'OS_REPROVADA'), msg(), {});

    expect(repo.updateStatusInTx).toHaveBeenCalledTimes(1);
  });

  it('integrates with SagaEventHandler passing the processor tx down to the repository', async () => {
    const { compensador, repo } = setup(osEm(StatusOS.AGUARDANDO_APROVACAO));
    const aplicarEvento = jest
      .fn()
      .mockResolvedValue(resultado('COMPENSAR', 'OS_REPROVADA'));
    const orchestrator = { aplicarEvento } as unknown as SagaOrchestrator;
    const [handler] = criarSagaEventHandlers(
      orchestrator,
      compensador.aoCompensar,
    );
    const tx = { id: 'tx-processador' };

    await handler.handle(msg(), tx);

    expect(repo.updateStatusInTx).toHaveBeenCalledWith(
      expect.objectContaining({ status: StatusOS.REPROVADA }),
      StatusOS.AGUARDANDO_APROVACAO,
      tx,
    );
  });
});
