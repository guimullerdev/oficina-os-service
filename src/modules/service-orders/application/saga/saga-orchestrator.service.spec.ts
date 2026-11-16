import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../prisma/prisma.service';
import { OutboxWriter } from '../../../../shared/messaging/outbox.writer';
import { EVENTOS_SAGA, SAGA_PASSOS } from './saga-definicao';
import {
  AGGREGATE_TYPE_OS,
  EVENTOS_EMITIDOS_POR_USE_CASES,
  PASSO_INICIADO_NO_DIAGNOSTICO,
  SagaConcorrenciaError,
  SagaOrchestrator,
  TIPO_SAGA_OS,
  transicoesDaCriacao,
} from './saga-orchestrator.service';
import type { SagaMetrics } from '../saga-metrics.service';
import { SagaComPassos, SagaPrismaRepository } from './saga.repository';

const AGORA = new Date('2025-01-01T12:00:00.000Z');
const HORA_MS = 60 * 60 * 1000;

type StatusPasso =
  | 'PENDENTE'
  | 'EM_ANDAMENTO'
  | 'CONCLUIDO'
  | 'FALHOU'
  | 'COMPENSADO'
  | 'EXPIRADO';

/** Monta uma saga cujos passos 1..n têm os status informados (demais PENDENTE). */
function makeSaga(
  statuses: StatusPasso[],
  extra: Partial<SagaComPassos> = {},
): SagaComPassos {
  return {
    id: 'saga-1',
    osId: 'os-1',
    tipo: TIPO_SAGA_OS,
    status: 'EM_ANDAMENTO',
    correlationId: 'corr-saga',
    iniciadaEm: AGORA,
    finalizadaEm: null,
    passos: SAGA_PASSOS.map((def, i) => {
      const status = statuses[i] ?? 'PENDENTE';
      return {
        id: `passo-${def.ordem}`,
        sagaId: 'saga-1',
        ordem: def.ordem,
        nome: def.nome,
        status,
        comando: def.comando,
        eventoEsperado: def.eventoEsperado,
        expiraEm:
          status === 'EM_ANDAMENTO'
            ? new Date(AGORA.getTime() + HORA_MS)
            : null,
        tentativas: status === 'PENDENTE' ? 0 : 1,
        erro: null,
        createdAt: AGORA,
        updatedAt: AGORA,
      };
    }),
    ...extra,
  } as SagaComPassos;
}

describe('SagaOrchestrator', () => {
  const tx = { marcador: 'tx' } as unknown as Prisma.TransactionClient;
  let queryRaw: jest.Mock;
  let txInterna: Prisma.TransactionClient;
  const envOriginal = process.env;

  let prisma: { $transaction: jest.Mock };
  let repo: {
    criar: jest.Mock;
    buscarPorOs: jest.Mock;
    buscarPorCorrelationId: jest.Mock;
    buscarPorId: jest.Mock;
    atualizarPassoSeStatus: jest.Mock;
    atualizarStatusSaga: jest.Mock;
  };
  let outbox: { append: jest.Mock };
  let metrics: { passoTransicao: jest.Mock; sagaStatus: jest.Mock };
  /** Ordem de 'commit' (fim do callback da $transaction) e 'metric'. */
  let ordem: string[];
  let orchestrator: SagaOrchestrator;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(AGORA);
    process.env = { ...envOriginal };
    delete process.env.SAGA_TIMEOUT_GERAR_ORCAMENTO_MS;

    queryRaw = jest.fn().mockResolvedValue([]);
    txInterna = {
      marcador: 'tx-interna',
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;
    ordem = [];
    prisma = {
      $transaction: jest.fn(async (cb: (c: unknown) => Promise<unknown>) => {
        const resultado = await cb(txInterna);
        ordem.push('commit');
        return resultado;
      }),
    };
    repo = {
      criar: jest.fn((dados) => Promise.resolve({ id: 'saga-1', ...dados })),
      buscarPorOs: jest.fn().mockResolvedValue(null),
      buscarPorCorrelationId: jest.fn().mockResolvedValue(null),
      buscarPorId: jest.fn().mockResolvedValue(null),
      atualizarPassoSeStatus: jest.fn().mockResolvedValue(1),
      atualizarStatusSaga: jest.fn().mockResolvedValue({}),
    };
    outbox = { append: jest.fn().mockResolvedValue(undefined) };
    metrics = {
      passoTransicao: jest.fn(() => {
        ordem.push('metric');
      }),
      sagaStatus: jest.fn(() => {
        ordem.push('metric');
      }),
    };
    orchestrator = new SagaOrchestrator(
      prisma as unknown as PrismaService,
      repo as unknown as SagaPrismaRepository,
      outbox as unknown as OutboxWriter,
      metrics as unknown as SagaMetrics,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = envOriginal;
  });

  describe('constantes', () => {
    it('expõe tipo, aggregate type e eventos que continuam nos use cases', () => {
      expect(TIPO_SAGA_OS).toBe('ORDEM_DE_SERVICO');
      expect(AGGREGATE_TYPE_OS).toBe('ordem_de_servico');
      expect(PASSO_INICIADO_NO_DIAGNOSTICO).toBe('GERAR_ORCAMENTO');
      expect([...EVENTOS_EMITIDOS_POR_USE_CASES].sort()).toEqual(
        [EVENTOS_SAGA.OS_CRIADA, EVENTOS_SAGA.DIAGNOSTICO_CONCLUIDO].sort(),
      );
    });
  });

  describe('iniciar', () => {
    it('cria a saga com o passo GERAR_ORCAMENTO adiado (PENDENTE, sem timer)', async () => {
      const saga = await orchestrator.iniciar('os-1', 'corr-1', tx);

      expect(repo.criar).toHaveBeenCalledTimes(1);
      const [dados, txUsado] = repo.criar.mock.calls[0];
      expect(txUsado).toBe(tx);
      expect(dados).toMatchObject({
        osId: 'os-1',
        tipo: TIPO_SAGA_OS,
        correlationId: 'corr-1',
        status: 'EM_ANDAMENTO',
      });
      expect(dados.passos).toHaveLength(SAGA_PASSOS.length);
      expect(dados.passos[0]).toEqual({
        ordem: 1,
        nome: 'ABRIR_OS',
        status: 'CONCLUIDO',
        tentativas: 1,
        expiraEm: null,
        comando: EVENTOS_SAGA.OS_CRIADA,
        eventoEsperado: null,
      });
      expect(dados.passos[1]).toEqual({
        ordem: 2,
        nome: 'GERAR_ORCAMENTO',
        status: 'PENDENTE',
        tentativas: 0,
        expiraEm: null,
        comando: EVENTOS_SAGA.DIAGNOSTICO_CONCLUIDO,
        eventoEsperado: EVENTOS_SAGA.ORCAMENTO_GERADO,
      });
      expect(
        dados.passos
          .slice(2)
          .every((p: { status: string }) => p.status === 'PENDENTE'),
      ).toBe(true);
      expect(saga.id).toBe('saga-1');
    });

    it('não reemite os.criada nem diagnostico.concluido e nunca abre transação', async () => {
      await orchestrator.iniciar('os-1', 'corr-1', tx);

      expect(outbox.append).toHaveBeenCalledWith(tx, []);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('propaga erros do repositório', async () => {
      repo.criar.mockRejectedValue(new Error('db down'));

      await expect(orchestrator.iniciar('os-1', 'corr-1', tx)).rejects.toThrow(
        'db down',
      );
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('registrarDiagnosticoConcluido', () => {
    it('move o passo GERAR_ORCAMENTO para EM_ANDAMENTO com timer e tentativa', async () => {
      repo.buscarPorOs.mockResolvedValue(makeSaga(['CONCLUIDO', 'PENDENTE']));

      const resultado = await orchestrator.registrarDiagnosticoConcluido(
        'os-1',
        tx,
      );

      expect(resultado).toEqual({
        sagaId: 'saga-1',
        osId: 'os-1',
        correlationId: 'corr-saga',
        passos: [
          {
            passo: 'GERAR_ORCAMENTO',
            ordem: 2,
            statusAnterior: 'PENDENTE',
            statusNovo: 'EM_ANDAMENTO',
          },
        ],
      });
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
      expect(metrics.sagaStatus).not.toHaveBeenCalled();
      expect(repo.buscarPorOs).toHaveBeenCalledWith('os-1', TIPO_SAGA_OS, tx);
      expect(repo.atualizarPassoSeStatus).toHaveBeenCalledWith(
        'passo-2',
        'PENDENTE',
        {
          status: 'EM_ANDAMENTO',
          expiraEm: new Date(AGORA.getTime() + HORA_MS),
          incrementarTentativas: true,
        },
        tx,
      );
      expect(outbox.append).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('respeita o timeout configurado no ambiente', async () => {
      process.env.SAGA_TIMEOUT_GERAR_ORCAMENTO_MS = '5000';
      repo.buscarPorOs.mockResolvedValue(makeSaga(['CONCLUIDO', 'PENDENTE']));

      await orchestrator.registrarDiagnosticoConcluido('os-1', tx);

      expect(repo.atualizarPassoSeStatus.mock.calls[0][2].expiraEm).toEqual(
        new Date(AGORA.getTime() + 5000),
      );
    });

    it('retorna null quando a saga não existe', async () => {
      expect(
        await orchestrator.registrarDiagnosticoConcluido('os-1', tx),
      ).toBeNull();
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
    });

    it('retorna null quando a saga não está EM_ANDAMENTO', async () => {
      repo.buscarPorOs.mockResolvedValue(
        makeSaga(['CONCLUIDO', 'PENDENTE'], { status: 'COMPENSADA' }),
      );

      expect(
        await orchestrator.registrarDiagnosticoConcluido('os-1', tx),
      ).toBeNull();
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
    });

    it('retorna null quando o passo GERAR_ORCAMENTO não existe', async () => {
      const saga = makeSaga(['CONCLUIDO', 'PENDENTE']);
      saga.passos = saga.passos.filter((p) => p.nome !== 'GERAR_ORCAMENTO');
      repo.buscarPorOs.mockResolvedValue(saga);

      expect(
        await orchestrator.registrarDiagnosticoConcluido('os-1', tx),
      ).toBeNull();
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
    });

    it('retorna null quando o passo já saiu de PENDENTE', async () => {
      repo.buscarPorOs.mockResolvedValue(
        makeSaga(['CONCLUIDO', 'EM_ANDAMENTO']),
      );

      expect(
        await orchestrator.registrarDiagnosticoConcluido('os-1', tx),
      ).toBeNull();
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
    });

    it('retorna null quando a atualização condicional não afeta linhas', async () => {
      repo.buscarPorOs.mockResolvedValue(makeSaga(['CONCLUIDO', 'PENDENTE']));
      repo.atualizarPassoSeStatus.mockResolvedValue(0);

      expect(
        await orchestrator.registrarDiagnosticoConcluido('os-1', tx),
      ).toBeNull();
      expect(metrics.passoTransicao).not.toHaveBeenCalled();
    });
  });

  describe('expirarVencidos', () => {
    const vencida = (extra: Partial<SagaComPassos> = {}): SagaComPassos => {
      const saga = makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO'], extra);
      saga.passos[2].expiraEm = new Date(AGORA.getTime() - 1000);
      return saga;
    };
    const linha = (id = 'passo-3', sagaId = 'saga-1') => ({ id, sagaId });

    let warn: jest.SpyInstance;

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => jest.restoreAllMocks());

    it('não escreve nada quando não há passo vencido', async () => {
      const resultado = await orchestrator.expirarVencidos();

      expect(resultado).toEqual({ expirados: 0 });
      expect(repo.buscarPorId).not.toHaveBeenCalled();
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
      expect(repo.atualizarStatusSaga).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('seleciona os vencidos com FOR UPDATE SKIP LOCKED, agora e limite', async () => {
      const outroAgora = new Date('2025-02-02T00:00:00.000Z');

      await orchestrator.expirarVencidos(outroAgora, 7);

      const [strings, ...valores] = queryRaw.mock.calls[0] as unknown as [
        string[],
        ...unknown[],
      ];
      const sql = strings.join('?');
      expect(sql).toContain('FROM saga_passos');
      expect(sql).toContain("status = 'EM_ANDAMENTO'");
      expect(sql).toContain('expira_em <=');
      expect(sql).toContain('ORDER BY expira_em');
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(valores).toEqual([outroAgora, 7]);
    });

    it('usa agora = new Date() e limite 50 por padrão', async () => {
      await orchestrator.expirarVencidos();

      const [, ...valores] = queryRaw.mock.calls[0] as unknown as unknown[];
      expect(valores).toEqual([AGORA, 50]);
    });

    it('expira o passo vencido: COMPENSADO, saga COMPENSADA e evento no outbox', async () => {
      queryRaw.mockResolvedValue([linha()]);
      repo.buscarPorId.mockResolvedValue(vencida());

      const resultado = await orchestrator.expirarVencidos(AGORA);

      expect(resultado).toEqual({ expirados: 1 });
      expect(repo.buscarPorId).toHaveBeenCalledWith('saga-1', txInterna);
      expect(repo.atualizarPassoSeStatus).toHaveBeenCalledTimes(1);
      expect(repo.atualizarPassoSeStatus).toHaveBeenCalledWith(
        'passo-3',
        'EM_ANDAMENTO',
        {
          status: 'COMPENSADO',
          expiraEm: null,
          erro: 'passo APROVAR_ORCAMENTO passou por EXPIRADO e foi COMPENSADO',
        },
        txInterna,
      );
      expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
        'saga-1',
        'COMPENSADA',
        AGORA,
        txInterna,
      );
      expect(outbox.append).toHaveBeenCalledTimes(1);
      expect(outbox.append).toHaveBeenCalledWith(txInterna, [
        {
          evento: EVENTOS_SAGA.SAGA_PASSO_EXPIRADO,
          aggregateType: AGGREGATE_TYPE_OS,
          aggregateId: 'os-1',
          payload: {
            id: 'os-1',
            sagaId: 'saga-1',
            ordem: 3,
            nome: 'APROVAR_ORCAMENTO',
            causadoPor: null,
          },
          correlationId: 'corr-saga',
          traceparent: undefined,
        },
      ]);
    });

    it('expira vários passos de sagas diferentes no mesmo lote', async () => {
      queryRaw.mockResolvedValue([
        linha('passo-3', 'saga-1'),
        linha('passo-3b', 'saga-2'),
      ]);
      repo.buscarPorId
        .mockResolvedValueOnce(vencida())
        .mockResolvedValueOnce(vencida({ id: 'saga-2', osId: 'os-2' }));

      const resultado = await orchestrator.expirarVencidos(AGORA);

      expect(resultado).toEqual({ expirados: 2 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(repo.atualizarStatusSaga).toHaveBeenCalledTimes(2);
      expect(outbox.append).toHaveBeenCalledTimes(2);
    });

    it('ignora a saga cuja decisão é IGNORAR (passo ainda não venceu)', async () => {
      queryRaw.mockResolvedValue([linha()]);
      repo.buscarPorId.mockResolvedValue(
        makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
      );

      const resultado = await orchestrator.expirarVencidos(AGORA);

      expect(resultado).toEqual({ expirados: 0 });
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
      expect(repo.atualizarStatusSaga).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('pula com aviso quando a saga do passo não existe mais', async () => {
      queryRaw.mockResolvedValue([linha()]);
      repo.buscarPorId.mockResolvedValue(null);

      const resultado = await orchestrator.expirarVencidos(AGORA);

      expect(resultado).toEqual({ expirados: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('saga-1'));
      expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('pula com aviso quando o passo já mudou (count 0) e segue o lote', async () => {
      queryRaw.mockResolvedValue([
        linha('passo-3', 'saga-1'),
        linha('passo-3b', 'saga-2'),
      ]);
      repo.buscarPorId
        .mockResolvedValueOnce(vencida())
        .mockResolvedValueOnce(vencida({ id: 'saga-2', osId: 'os-2' }));
      repo.atualizarPassoSeStatus
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const resultado = await orchestrator.expirarVencidos(AGORA);

      expect(resultado).toEqual({ expirados: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('saga-1'));
      expect(repo.atualizarStatusSaga).toHaveBeenCalledTimes(1);
      expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
        'saga-2',
        'COMPENSADA',
        AGORA,
        txInterna,
      );
      expect(outbox.append).toHaveBeenCalledTimes(1);
    });

    it('não abre transação aninhada: usa uma única $transaction e o tx dela', async () => {
      queryRaw.mockResolvedValue([linha()]);
      repo.buscarPorId.mockResolvedValue(vencida());

      await orchestrator.expirarVencidos(AGORA);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(repo.buscarPorId).toHaveBeenCalledWith('saga-1', txInterna);
      expect(repo.atualizarPassoSeStatus).toHaveBeenCalledWith(
        'passo-3',
        'EM_ANDAMENTO',
        expect.anything(),
        txInterna,
      );
      expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
        'saga-1',
        'COMPENSADA',
        AGORA,
        txInterna,
      );
      expect(outbox.append).toHaveBeenCalledWith(txInterna, expect.any(Array));
    });

    it('propaga erro de um passo para reverter o lote inteiro', async () => {
      queryRaw.mockResolvedValue([
        linha('passo-3', 'saga-1'),
        linha('passo-3b', 'saga-2'),
      ]);
      repo.buscarPorId.mockResolvedValue(vencida());
      outbox.append
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('outbox down'));

      await expect(orchestrator.expirarVencidos(AGORA)).rejects.toThrow(
        'outbox down',
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('propaga erro da consulta de vencidos', async () => {
      queryRaw.mockRejectedValue(new Error('db down'));

      await expect(orchestrator.expirarVencidos(AGORA)).rejects.toThrow(
        'db down',
      );
    });
  });

  describe('aplicarEvento', () => {
    const envelope = {
      eventId: 'evt-1',
      correlationId: 'corr-envelope',
      osId: 'os-1',
      traceparent: '00-trace',
    };

    describe('transação', () => {
      it('usa o tx informado sem abrir transação própria', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(repo.buscarPorOs).toHaveBeenCalledWith('os-1', TIPO_SAGA_OS, tx);
        expect(outbox.append.mock.calls[0][0]).toBe(tx);
      });

      it('abre $transaction quando não recebe tx', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(repo.buscarPorOs).toHaveBeenCalledWith(
          'os-1',
          TIPO_SAGA_OS,
          txInterna,
        );
        expect(outbox.append.mock.calls[0][0]).toBe(txInterna);
      });
    });

    describe('localização da saga', () => {
      it('cai para o correlationId quando não há osId no envelope', async () => {
        repo.buscarPorCorrelationId.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          { eventId: 'evt-1', correlationId: 'corr-saga' },
          tx,
        );

        expect(repo.buscarPorOs).not.toHaveBeenCalled();
        expect(repo.buscarPorCorrelationId).toHaveBeenCalledWith(
          'corr-saga',
          tx,
        );
        expect(resultado.encontrada).toBe(true);
      });

      it('cai para o correlationId quando o osId não tem saga', async () => {
        repo.buscarPorCorrelationId.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(repo.buscarPorOs).toHaveBeenCalledTimes(1);
        expect(repo.buscarPorCorrelationId).toHaveBeenCalledWith(
          'corr-envelope',
          tx,
        );
        expect(resultado.encontrada).toBe(true);
      });

      it('não lança e devolve encontrada=false quando nada localiza a saga', async () => {
        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(resultado.encontrada).toBe(false);
        expect(resultado).toEqual({
          encontrada: false,
          motivo: expect.stringContaining(EVENTOS_SAGA.ORCAMENTO_APROVADO),
        });
        expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
        expect(outbox.append).not.toHaveBeenCalled();
      });

      it('devolve encontrada=false quando o envelope não tem osId nem correlationId', async () => {
        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          { eventId: 'evt-1' },
          tx,
        );

        expect(resultado.encontrada).toBe(false);
        expect(repo.buscarPorOs).not.toHaveBeenCalled();
        expect(repo.buscarPorCorrelationId).not.toHaveBeenCalled();
      });
    });

    describe('decisões sem escrita', () => {
      it('IGNORAR (evento fora de ordem) não escreve nada', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
          envelope,
          tx,
        );

        expect(resultado).toMatchObject({
          encontrada: true,
          sagaId: 'saga-1',
          osId: 'os-1',
          decisao: { tipo: 'IGNORAR' },
        });
        expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
        expect(repo.atualizarStatusSaga).not.toHaveBeenCalled();
        expect(outbox.append).not.toHaveBeenCalled();
      });

      it('PROGRESSO não escreve nada', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.EXECUCAO_INICIADA,
          envelope,
          tx,
        );

        expect(resultado).toMatchObject({
          encontrada: true,
          decisao: { tipo: 'PROGRESSO' },
        });
        expect(repo.atualizarPassoSeStatus).not.toHaveBeenCalled();
        expect(outbox.append).not.toHaveBeenCalled();
      });
    });

    describe('AVANCAR', () => {
      it('conclui o passo atual, inicia o próximo e emite o comando da saga', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(repo.atualizarPassoSeStatus).toHaveBeenCalledTimes(2);
        expect(repo.atualizarPassoSeStatus).toHaveBeenNthCalledWith(
          1,
          'passo-3',
          'EM_ANDAMENTO',
          {
            status: 'CONCLUIDO',
            expiraEm: null,
            erro: undefined,
            incrementarTentativas: false,
          },
          tx,
        );
        expect(repo.atualizarPassoSeStatus).toHaveBeenNthCalledWith(
          2,
          'passo-4',
          'PENDENTE',
          {
            status: 'EM_ANDAMENTO',
            expiraEm: new Date(AGORA.getTime() + HORA_MS),
            erro: undefined,
            incrementarTentativas: true,
          },
          tx,
        );
        expect(repo.atualizarStatusSaga).not.toHaveBeenCalled();
        expect(outbox.append).toHaveBeenCalledWith(tx, [
          {
            evento: EVENTOS_SAGA.OS_EXECUCAO_SOLICITADA,
            aggregateType: AGGREGATE_TYPE_OS,
            aggregateId: 'os-1',
            payload: {
              id: 'os-1',
              sagaId: 'saga-1',
              ordem: 4,
              nome: 'EXECUTAR',
              causadoPor: 'evt-1',
            },
            correlationId: 'corr-saga',
            traceparent: '00-trace',
          },
        ]);
        expect(resultado).toMatchObject({
          encontrada: true,
          sagaId: 'saga-1',
          osId: 'os-1',
          decisao: { tipo: 'AVANCAR' },
        });
      });

      it('não emite eventos quando o próximo passo não tem comando', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'EM_ANDAMENTO']),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_GERADO,
          envelope,
          tx,
        );

        expect(repo.atualizarPassoSeStatus).toHaveBeenCalledTimes(2);
        expect(outbox.append).toHaveBeenCalledWith(tx, []);
      });

      it('finaliza a saga como CONCLUIDA com finalizadaEm quando acaba o último passo', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga([
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'EM_ANDAMENTO',
          ]),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
          envelope,
          tx,
        );

        expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
          'saga-1',
          'CONCLUIDA',
          AGORA,
          tx,
        );
        const eventos = outbox.append.mock.calls[0][1];
        expect(eventos.map((e: { evento: string }) => e.evento)).toEqual([
          EVENTOS_SAGA.OS_FINALIZADA,
        ]);
      });
    });

    describe('COMPENSAR', () => {
      it('compensa o passo, grava o motivo e encerra a saga como COMPENSADA', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_REPROVADO,
          envelope,
          tx,
        );

        expect(repo.atualizarPassoSeStatus).toHaveBeenCalledTimes(1);
        expect(repo.atualizarPassoSeStatus).toHaveBeenCalledWith(
          'passo-3',
          'EM_ANDAMENTO',
          {
            status: 'COMPENSADO',
            expiraEm: null,
            erro: 'passo APROVAR_ORCAMENTO recebeu orcamento.reprovado',
            incrementarTentativas: false,
          },
          tx,
        );
        expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
          'saga-1',
          'COMPENSADA',
          AGORA,
          tx,
        );
        expect(outbox.append).toHaveBeenCalledWith(tx, []);
        expect(resultado).toMatchObject({ decisao: { tipo: 'COMPENSAR' } });
      });

      it('muda a saga para PENDENTE (não terminal) sem finalizadaEm', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga([
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'EM_ANDAMENTO',
          ]),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.PAGAMENTO_RECUSADO,
          envelope,
          tx,
        );

        expect(repo.atualizarPassoSeStatus.mock.calls[0][2].status).toBe(
          'FALHOU',
        );
        expect(repo.atualizarStatusSaga).toHaveBeenCalledWith(
          'saga-1',
          'PENDENTE',
          undefined,
          tx,
        );
      });
    });

    describe('inconsistências e concorrência', () => {
      it('lança quando a decisão referencia um passo inexistente na saga', async () => {
        const saga = makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']);
        saga.passos = saga.passos.filter((p) => p.ordem !== 4);
        repo.buscarPorOs.mockResolvedValue(saga);

        await expect(
          orchestrator.aplicarEvento(
            EVENTOS_SAGA.ORCAMENTO_APROVADO,
            envelope,
            tx,
          ),
        ).rejects.toThrow('passo 4 inexistente na saga saga-1');
        expect(outbox.append).not.toHaveBeenCalled();
      });

      it('devolve IGNORAR quando o primeiro passo já mudou (lock otimista)', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );
        repo.atualizarPassoSeStatus.mockResolvedValue(0);

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(repo.atualizarPassoSeStatus).toHaveBeenCalledTimes(1);
        expect(repo.atualizarStatusSaga).not.toHaveBeenCalled();
        expect(outbox.append).not.toHaveBeenCalled();
        expect(resultado).toEqual({
          encontrada: true,
          sagaId: 'saga-1',
          osId: 'os-1',
          decisao: {
            tipo: 'IGNORAR',
            passosAlterados: [],
            comandos: [],
            novoStatusSaga: 'EM_ANDAMENTO',
            motivo: expect.stringContaining('concorrência'),
          },
          transicoes: {
            sagaId: 'saga-1',
            osId: 'os-1',
            correlationId: 'corr-saga',
            passos: [],
            saga: undefined,
          },
        });
      });

      it('lança SagaConcorrenciaError quando um passo seguinte mudou no meio da aplicação', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );
        repo.atualizarPassoSeStatus
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(0);

        const promessa = orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        await expect(promessa).rejects.toBeInstanceOf(SagaConcorrenciaError);
        await expect(promessa).rejects.toMatchObject({
          name: 'SagaConcorrenciaError',
          sagaId: 'saga-1',
          ordem: 4,
          message:
            'concorrência na saga saga-1: passo 4 mudou durante a aplicação',
        });
        expect(outbox.append).not.toHaveBeenCalled();
      });

      it('propaga falhas do outbox para o chamador reverter a transação', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );
        outbox.append.mockRejectedValue(new Error('outbox down'));

        await expect(
          orchestrator.aplicarEvento(
            EVENTOS_SAGA.ORCAMENTO_APROVADO,
            envelope,
            tx,
          ),
        ).rejects.toThrow('outbox down');
      });
    });
  });

  describe('métricas de transição', () => {
    const envelope = {
      eventId: 'evt-1',
      correlationId: 'corr-envelope',
      osId: 'os-1',
    };
    const base = { sagaId: 'saga-1', osId: 'os-1', correlationId: 'corr-saga' };
    const vencida = (extra: Partial<SagaComPassos> = {}): SagaComPassos => {
      const saga = makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO'], extra);
      saga.passos[2].expiraEm = new Date(AGORA.getTime() - 1000);
      return saga;
    };
    const linha = (id = 'passo-3', sagaId = 'saga-1') => ({ id, sagaId });

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => jest.restoreAllMocks());

    describe('transicoesDaCriacao / iniciar', () => {
      it('descreve os 6 passos (anterior nulo) e a saga criada; iniciar não emite', async () => {
        const saga = await orchestrator.iniciar('os-1', 'corr-saga', tx);

        const t = transicoesDaCriacao(saga);

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
        expect(t).toMatchObject(base);
        expect(t.passos).toHaveLength(6);
        expect(t.passos.every((p) => p.statusAnterior === null)).toBe(true);
        expect(t.passos.map((p) => p.statusNovo)).toEqual([
          'CONCLUIDO',
          'PENDENTE',
          'PENDENTE',
          'PENDENTE',
          'PENDENTE',
          'PENDENTE',
        ]);
        expect(t.passos[0]).toEqual({
          passo: 'ABRIR_OS',
          ordem: 1,
          statusAnterior: null,
          statusNovo: 'CONCLUIDO',
        });
        expect(t.saga).toEqual({
          statusAnterior: null,
          statusNovo: 'EM_ANDAMENTO',
        });
      });
    });

    describe('emitirTransicoes', () => {
      it('emite os passos e depois a saga', () => {
        orchestrator.emitirTransicoes({
          ...base,
          passos: [
            {
              passo: 'EXECUTAR',
              ordem: 4,
              statusAnterior: 'PENDENTE',
              statusNovo: 'EM_ANDAMENTO',
            },
            {
              passo: 'COBRAR',
              ordem: 5,
              statusAnterior: null,
              statusNovo: 'PENDENTE',
            },
          ],
          saga: { statusAnterior: 'EM_ANDAMENTO', statusNovo: 'CONCLUIDA' },
        });

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(2);
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(1, {
          ...base,
          passo: 'EXECUTAR',
          ordem: 4,
          statusAnterior: 'PENDENTE',
          statusNovo: 'EM_ANDAMENTO',
        });
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(2, {
          ...base,
          passo: 'COBRAR',
          ordem: 5,
          statusAnterior: null,
          statusNovo: 'PENDENTE',
        });
        expect(metrics.sagaStatus).toHaveBeenCalledTimes(1);
        expect(metrics.sagaStatus).toHaveBeenCalledWith({
          ...base,
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'CONCLUIDA',
        });
        expect(ordem).toEqual(['metric', 'metric', 'metric']);
      });

      it('não emite sagaStatus quando a saga não mudou de status', () => {
        orchestrator.emitirTransicoes({
          ...base,
          passos: [
            {
              passo: 'EXECUTAR',
              ordem: 4,
              statusAnterior: 'PENDENTE',
              statusNovo: 'EM_ANDAMENTO',
            },
          ],
        });

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(1);
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('não emite nada quando não há transições', () => {
        orchestrator.emitirTransicoes({ ...base, passos: [] });

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });
    });

    describe('expirarVencidos', () => {
      it('emite os dois passos (EXPIRADO, COMPENSADO) e a saga só depois do commit', async () => {
        queryRaw.mockResolvedValue([linha()]);
        repo.buscarPorId.mockResolvedValue(vencida());

        await orchestrator.expirarVencidos(AGORA);

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(2);
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(1, {
          ...base,
          passo: 'APROVAR_ORCAMENTO',
          ordem: 3,
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'EXPIRADO',
        });
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(2, {
          ...base,
          passo: 'APROVAR_ORCAMENTO',
          ordem: 3,
          statusAnterior: 'EXPIRADO',
          statusNovo: 'COMPENSADO',
        });
        expect(metrics.sagaStatus).toHaveBeenCalledTimes(1);
        expect(metrics.sagaStatus).toHaveBeenCalledWith({
          ...base,
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'COMPENSADA',
        });
        expect(ordem).toEqual(['commit', 'metric', 'metric', 'metric']);
      });

      it('saga já COMPENSADA: ainda grava o status, emite os 2 passos e não emite sagaStatus', async () => {
        queryRaw.mockResolvedValue([linha()]);
        repo.buscarPorId.mockResolvedValue(vencida({ status: 'COMPENSADA' }));

        await orchestrator.expirarVencidos(AGORA);

        expect(repo.atualizarStatusSaga).toHaveBeenCalledTimes(1);
        expect(metrics.passoTransicao).toHaveBeenCalledTimes(2);
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('lote de 2 sagas: 4 passos e 2 sagaStatus, o 2º com osId os-2', async () => {
        queryRaw.mockResolvedValue([
          linha('passo-3', 'saga-1'),
          linha('passo-3b', 'saga-2'),
        ]);
        repo.buscarPorId
          .mockResolvedValueOnce(vencida())
          .mockResolvedValueOnce(vencida({ id: 'saga-2', osId: 'os-2' }));

        await orchestrator.expirarVencidos(AGORA);

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(4);
        expect(metrics.sagaStatus).toHaveBeenCalledTimes(2);
        expect(metrics.sagaStatus).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ sagaId: 'saga-2', osId: 'os-2' }),
        );
        expect(ordem[0]).toBe('commit');
      });

      it('IGNORAR não emite métricas', async () => {
        queryRaw.mockResolvedValue([linha()]);
        repo.buscarPorId.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        await orchestrator.expirarVencidos(AGORA);

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('saga inexistente não emite métricas', async () => {
        queryRaw.mockResolvedValue([linha()]);
        repo.buscarPorId.mockResolvedValue(null);

        await orchestrator.expirarVencidos(AGORA);

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('count 0 pula o passo; só o passo processado emite', async () => {
        queryRaw.mockResolvedValue([
          linha('passo-3', 'saga-1'),
          linha('passo-3b', 'saga-2'),
        ]);
        repo.buscarPorId
          .mockResolvedValueOnce(vencida())
          .mockResolvedValueOnce(vencida({ id: 'saga-2', osId: 'os-2' }));
        repo.atualizarPassoSeStatus
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(1);

        await orchestrator.expirarVencidos(AGORA);

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(2);
        expect(metrics.passoTransicao).toHaveBeenCalledWith(
          expect.objectContaining({ sagaId: 'saga-2', osId: 'os-2' }),
        );
        expect(metrics.sagaStatus).toHaveBeenCalledTimes(1);
      });

      it('erro no lote (2º passo) reverte e não emite nada', async () => {
        queryRaw.mockResolvedValue([
          linha('passo-3', 'saga-1'),
          linha('passo-3b', 'saga-2'),
        ]);
        repo.buscarPorId.mockResolvedValue(vencida());
        outbox.append
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('outbox down'));

        await expect(orchestrator.expirarVencidos(AGORA)).rejects.toThrow(
          'outbox down',
        );

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('erro na consulta não emite nada', async () => {
        queryRaw.mockRejectedValue(new Error('db down'));

        await expect(orchestrator.expirarVencidos(AGORA)).rejects.toThrow(
          'db down',
        );

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });
    });

    describe('aplicarEvento', () => {
      it('com tx: devolve transicoes e não emite (o dono do commit emite)', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
          tx,
        );

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
        expect(resultado).toMatchObject({
          encontrada: true,
          transicoes: base,
        });
      });

      it('sem tx: emite após o commit da própria transação', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
        );

        expect(metrics.passoTransicao).toHaveBeenCalledTimes(2);
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(1, {
          ...base,
          passo: 'APROVAR_ORCAMENTO',
          ordem: 3,
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'CONCLUIDO',
        });
        expect(metrics.passoTransicao).toHaveBeenNthCalledWith(2, {
          ...base,
          passo: 'EXECUTAR',
          ordem: 4,
          statusAnterior: 'PENDENTE',
          statusNovo: 'EM_ANDAMENTO',
        });
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
        expect(ordem).toEqual(['commit', 'metric', 'metric']);
      });

      it('sem tx: falha do outbox reverte e não emite', async () => {
        repo.buscarPorOs.mockResolvedValue(
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );
        outbox.append.mockRejectedValue(new Error('outbox down'));

        await expect(
          orchestrator.aplicarEvento(EVENTOS_SAGA.ORCAMENTO_APROVADO, envelope),
        ).rejects.toThrow('outbox down');

        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });

      it('sem tx: saga não encontrada não emite', async () => {
        const resultado = await orchestrator.aplicarEvento(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          envelope,
        );

        expect(resultado.encontrada).toBe(false);
        expect(metrics.passoTransicao).not.toHaveBeenCalled();
        expect(metrics.sagaStatus).not.toHaveBeenCalled();
      });
    });

    describe('conteúdo de transicoes', () => {
      const transicoesDe = async (
        evento: string,
        saga: SagaComPassos,
        txUsado: Prisma.TransactionClient | undefined = tx,
      ) => {
        repo.buscarPorOs.mockResolvedValue(saga);
        const r = await orchestrator.aplicarEvento(evento, envelope, txUsado);
        if (!r.encontrada) throw new Error('saga não encontrada');
        return r.transicoes;
      };

      it('AVANCAR: um item por passo alterado e saga inalterada', async () => {
        const t = await transicoesDe(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        expect(t.passos).toEqual([
          {
            passo: 'APROVAR_ORCAMENTO',
            ordem: 3,
            statusAnterior: 'EM_ANDAMENTO',
            statusNovo: 'CONCLUIDO',
          },
          {
            passo: 'EXECUTAR',
            ordem: 4,
            statusAnterior: 'PENDENTE',
            statusNovo: 'EM_ANDAMENTO',
          },
        ]);
        expect(t.saga).toBeUndefined();
      });

      it('AVANCAR final: saga EM_ANDAMENTO -> CONCLUIDA', async () => {
        const t = await transicoesDe(
          EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
          makeSaga([
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'EM_ANDAMENTO',
          ]),
        );

        expect(t.passos).toEqual([
          {
            passo: 'COBRAR',
            ordem: 5,
            statusAnterior: 'EM_ANDAMENTO',
            statusNovo: 'CONCLUIDO',
          },
          {
            passo: 'CONFIRMAR',
            ordem: 6,
            statusAnterior: 'PENDENTE',
            statusNovo: 'CONCLUIDO',
          },
        ]);
        expect(t.saga).toEqual({
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'CONCLUIDA',
        });
      });

      it('COMPENSAR: passo COMPENSADO e saga COMPENSADA', async () => {
        const t = await transicoesDe(
          EVENTOS_SAGA.ORCAMENTO_REPROVADO,
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        expect(t.passos).toEqual([
          {
            passo: 'APROVAR_ORCAMENTO',
            ordem: 3,
            statusAnterior: 'EM_ANDAMENTO',
            statusNovo: 'COMPENSADO',
          },
        ]);
        expect(t.saga).toEqual({
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'COMPENSADA',
        });
      });

      it('pagamento recusado: saga EM_ANDAMENTO -> PENDENTE', async () => {
        const t = await transicoesDe(
          EVENTOS_SAGA.PAGAMENTO_RECUSADO,
          makeSaga([
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'CONCLUIDO',
            'EM_ANDAMENTO',
          ]),
        );

        expect(t.passos[0]).toMatchObject({
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'FALHOU',
        });
        expect(t.saga).toEqual({
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'PENDENTE',
        });
      });

      it('IGNORAR, PROGRESSO e lock otimista não geram transições', async () => {
        const ignorar = await transicoesDe(
          EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
          makeSaga(['CONCLUIDO', 'EM_ANDAMENTO']),
        );
        const progresso = await transicoesDe(
          EVENTOS_SAGA.EXECUCAO_INICIADA,
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );
        repo.atualizarPassoSeStatus.mockResolvedValue(0);
        const otimista = await transicoesDe(
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
        );

        for (const t of [ignorar, progresso, otimista]) {
          expect(t).toEqual({ ...base, passos: [], saga: undefined });
        }
      });

      it('SagaConcorrenciaError e falha do outbox rejeitam (sem transições)', async () => {
        repo.atualizarPassoSeStatus
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(0);
        await expect(
          transicoesDe(
            EVENTOS_SAGA.ORCAMENTO_APROVADO,
            makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
          ),
        ).rejects.toBeInstanceOf(SagaConcorrenciaError);

        outbox.append.mockRejectedValue(new Error('outbox down'));
        await expect(
          transicoesDe(
            EVENTOS_SAGA.ORCAMENTO_APROVADO,
            makeSaga(['CONCLUIDO', 'CONCLUIDO', 'EM_ANDAMENTO']),
          ),
        ).rejects.toThrow('outbox down');
      });
    });

    describe('fluxo feliz com repositório com estado', () => {
      it('emite a sequência completa de transições até CONCLUIDA', async () => {
        type PassoFake = SagaComPassos['passos'][number];
        let estado: SagaComPassos | undefined;
        const fake = {
          criar: jest.fn((dados: Record<string, unknown>) => {
            const passosDados = dados.passos as Array<{
              ordem: number;
              nome: string;
              status: PassoFake['status'];
              tentativas: number;
              expiraEm: Date | null;
              comando: string;
              eventoEsperado: string | null;
            }>;
            estado = {
              id: 'saga-1',
              osId: dados.osId,
              tipo: dados.tipo,
              correlationId: dados.correlationId,
              status: dados.status,
              iniciadaEm: AGORA,
              finalizadaEm: null,
              passos: passosDados.map((p) => ({
                ...p,
                id: `passo-${p.ordem}`,
                sagaId: 'saga-1',
                erro: null,
                createdAt: AGORA,
                updatedAt: AGORA,
              })),
            } as unknown as SagaComPassos;
            return Promise.resolve(structuredClone(estado));
          }),
          buscarPorOs: jest.fn(() =>
            Promise.resolve(estado ? structuredClone(estado) : null),
          ),
          buscarPorCorrelationId: jest.fn().mockResolvedValue(null),
          buscarPorId: jest.fn(),
          atualizarPassoSeStatus: jest.fn(
            (
              id: string,
              esperado: string,
              dados: {
                status: PassoFake['status'];
                incrementarTentativas?: boolean;
              },
            ) => {
              const passo = estado?.passos.find((p) => p.id === id);
              if (!passo || passo.status !== esperado)
                return Promise.resolve(0);
              passo.status = dados.status;
              if (dados.incrementarTentativas) passo.tentativas += 1;
              return Promise.resolve(1);
            },
          ),
          atualizarStatusSaga: jest.fn((_id: string, status: string) => {
            if (estado) estado.status = status as SagaComPassos['status'];
            return Promise.resolve({});
          }),
        };
        const orq = new SagaOrchestrator(
          prisma as unknown as PrismaService,
          fake as unknown as SagaPrismaRepository,
          outbox as unknown as OutboxWriter,
          metrics as unknown as SagaMetrics,
        );

        const saga = await orq.iniciar('os-1', 'corr-saga', tx);
        orq.emitirTransicoes(transicoesDaCriacao(saga));
        const diag = await orq.registrarDiagnosticoConcluido('os-1', tx);
        if (!diag) throw new Error('diagnóstico não registrado');
        orq.emitirTransicoes(diag);
        for (const evento of [
          EVENTOS_SAGA.ORCAMENTO_GERADO,
          EVENTOS_SAGA.ORCAMENTO_APROVADO,
          EVENTOS_SAGA.EXECUCAO_CONCLUIDA,
          EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
        ]) {
          const r = await orq.aplicarEvento(evento, envelope, tx);
          if (!r.encontrada) throw new Error(`saga não encontrada: ${evento}`);
          orq.emitirTransicoes(r.transicoes);
        }

        expect(estado?.status).toBe('CONCLUIDA');
        const concluidos = metrics.passoTransicao.mock.calls
          .map(([i]) => i as { passo: string; statusNovo: string })
          .filter((i) => i.statusNovo === 'CONCLUIDO')
          .map((i) => i.passo);
        expect(concluidos).toEqual([
          'ABRIR_OS',
          'GERAR_ORCAMENTO',
          'APROVAR_ORCAMENTO',
          'EXECUTAR',
          'COBRAR',
          'CONFIRMAR',
        ]);
        expect(
          metrics.sagaStatus.mock.calls.map(
            ([i]) => (i as { statusNovo: string }).statusNovo,
          ),
        ).toEqual(['EM_ANDAMENTO', 'CONCLUIDA']);
        const todas = [
          ...metrics.passoTransicao.mock.calls,
          ...metrics.sagaStatus.mock.calls,
        ].map(([i]) => (i as { correlationId: string }).correlationId);
        expect(new Set(todas)).toEqual(new Set(['corr-saga']));
      });
    });
  });
});
