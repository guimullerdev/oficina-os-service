import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StatusPassoSaga, StatusSaga } from '@prisma/client';

import { PrismaService } from '../../../../prisma/prisma.service';
import { DomainEvent } from '../../../../shared/messaging/domain-event';
import { OutboxWriter } from '../../../../shared/messaging/outbox.writer';
import type { SagaMetrics } from '../saga-metrics.service';
import {
  DEFINICAO_POR_NOME,
  EVENTOS_SAGA,
  timeoutPadraoMs,
} from './saga-definicao';
import type { NomePassoSaga } from './saga-definicao';
import {
  aplicarEvento as decidirEvento,
  expirar as decidirExpiracao,
  iniciar as decidirInicio,
} from './saga-maquina';
import type {
  ComandoSaga,
  DecisaoSaga,
  PassoAlterado,
  SagaSnapshot,
} from './saga-maquina';
import {
  PassoSagaCriacao,
  SagaComPassos,
  SagaPrismaRepository,
} from './saga.repository';

export const TIPO_SAGA_OS = 'ORDEM_DE_SERVICO';
export const AGGREGATE_TYPE_OS = 'ordem_de_servico';

/**
 * `os.criada` e `diagnostico.concluido` (payload rico) continuam sendo
 * emitidos pelos use cases; a saga só registra os passos correspondentes.
 */
export const EVENTOS_EMITIDOS_POR_USE_CASES: ReadonlySet<string> = new Set([
  EVENTOS_SAGA.OS_CRIADA,
  EVENTOS_SAGA.DIAGNOSTICO_CONCLUIDO,
]);

/** Passo que só começa quando o diagnóstico é concluído (não na criação). */
export const PASSO_INICIADO_NO_DIAGNOSTICO: NomePassoSaga = 'GERAR_ORCAMENTO';

const STATUS_TERMINAIS: ReadonlySet<string> = new Set([
  'CONCLUIDA',
  'COMPENSADA',
  'FALHOU',
]);

/** Quantos passos vencidos uma execução de `expirarVencidos` processa. */
export const LIMITE_EXPIRACAO_PADRAO = 50;
// A transação segura os locks enquanto processa o lote; o default do Prisma
// (5s) é curto para N passos x (leitura + 3 escritas).
const TRANSACTION_TIMEOUT_MS = 30_000;

export interface EnvelopeEventoSaga {
  eventId: string;
  correlationId?: string;
  osId?: string;
  payload?: unknown;
  traceparent?: string;
}

export interface ResultadoExpiracao {
  expirados: number;
}

interface PassoVencido {
  id: string;
  sagaId: string;
}

export interface TransicaoPassoSaga {
  passo: string;
  ordem: number;
  statusAnterior: StatusPassoSaga | null;
  statusNovo: StatusPassoSaga;
}

export interface TransicaoStatusSaga {
  statusAnterior: StatusSaga | null;
  statusNovo: StatusSaga;
}

/** Transitions to emit as metrics ONLY after the transaction that wrote them commits. */
export interface TransicoesSaga {
  sagaId: string;
  osId: string;
  correlationId: string;
  passos: TransicaoPassoSaga[];
  saga?: TransicaoStatusSaga;
}

export type ResultadoAplicacaoSaga =
  | { encontrada: false; motivo: string }
  | {
      encontrada: true;
      sagaId: string;
      osId: string;
      decisao: DecisaoSaga;
      transicoes: TransicoesSaga;
    };

export class SagaConcorrenciaError extends Error {
  constructor(
    readonly sagaId: string,
    readonly ordem: number,
  ) {
    super(
      `concorrência na saga ${sagaId}: passo ${ordem} mudou durante a aplicação`,
    );
    this.name = 'SagaConcorrenciaError';
  }
}

function transicaoSaga(
  anterior: StatusSaga,
  novo: StatusSaga,
): TransicaoStatusSaga | undefined {
  return anterior === novo
    ? undefined
    : { statusAnterior: anterior, statusNovo: novo };
}

/** Transições de uma saga recém-criada (passos e saga com statusAnterior nulo). */
export function transicoesDaCriacao(saga: SagaComPassos): TransicoesSaga {
  return {
    sagaId: saga.id,
    osId: saga.osId,
    correlationId: saga.correlationId,
    passos: saga.passos.map((p) => ({
      passo: p.nome,
      ordem: p.ordem,
      statusAnterior: null,
      statusNovo: p.status,
    })),
    saga: { statusAnterior: null, statusNovo: saga.status },
  };
}

function paraSnapshot(saga: SagaComPassos): SagaSnapshot {
  return {
    status: saga.status,
    passos: saga.passos.map((p) => ({
      ordem: p.ordem,
      nome: p.nome as NomePassoSaga,
      status: p.status,
      tentativas: p.tentativas,
      expiraEm: p.expiraEm,
    })),
  };
}

function adiarPassoDoDiagnostico(passo: PassoAlterado): PassoAlterado {
  if (passo.nome !== PASSO_INICIADO_NO_DIAGNOSTICO) return passo;
  return { ...passo, status: 'PENDENTE', tentativas: 0, expiraEm: null };
}

function paraCriacao(passo: PassoAlterado): PassoSagaCriacao {
  const definicao = DEFINICAO_POR_NOME[passo.nome];
  return {
    ordem: passo.ordem,
    nome: passo.nome,
    status: passo.status,
    tentativas: passo.tentativas,
    expiraEm: passo.expiraEm,
    comando: definicao.comando,
    eventoEsperado: definicao.eventoEsperado,
  };
}

function paraEventos(
  saga: { id: string; osId: string; correlationId: string },
  comandos: ComandoSaga[],
  origem: { eventId: string | null; traceparent?: string },
): DomainEvent[] {
  return comandos
    .filter((c) => !EVENTOS_EMITIDOS_POR_USE_CASES.has(c.evento))
    .map((c) => ({
      evento: c.evento,
      aggregateType: AGGREGATE_TYPE_OS,
      aggregateId: saga.osId,
      payload: {
        id: saga.osId,
        sagaId: saga.id,
        ordem: c.payload.ordem,
        nome: c.payload.nome,
        causadoPor: origem.eventId,
      },
      correlationId: saga.correlationId,
      traceparent: origem.traceparent,
    }));
}

// Dependências tipadas por contrato mínimo (type alias). A classe não usa
// decorators de DI: o módulo a instancia via factory (ver service-orders.module).
// Decorators de construtor geram ramos de helper/metadata (isolatedModules)
// impossíveis de cobrir nos testes.
type PrismaTransacional = Pick<PrismaService, '$transaction'>;
type SagaRepositorio = Pick<
  SagaPrismaRepository,
  | 'criar'
  | 'buscarPorOs'
  | 'buscarPorCorrelationId'
  | 'buscarPorId'
  | 'atualizarPassoSeStatus'
  | 'atualizarStatusSaga'
>;
type OutboxSaga = Pick<OutboxWriter, 'append'>;
type SagaMetricas = Pick<SagaMetrics, 'passoTransicao' | 'sagaStatus'>;

export class SagaOrchestrator {
  private readonly logger = new Logger(SagaOrchestrator.name);

  constructor(
    private readonly prisma: PrismaTransacional,
    private readonly repo: SagaRepositorio,
    private readonly outbox: OutboxSaga,
    private readonly metrics: SagaMetricas,
  ) {}

  /**
   * Emite as métricas das transições (passos primeiro, depois a saga). Deve
   * ser chamado só depois do commit da transação que gravou as transições.
   */
  emitirTransicoes(t: TransicoesSaga): void {
    const base = {
      sagaId: t.sagaId,
      osId: t.osId,
      correlationId: t.correlationId,
    };
    for (const p of t.passos) this.metrics.passoTransicao({ ...base, ...p });
    if (t.saga) this.metrics.sagaStatus({ ...base, ...t.saga });
  }

  /** Cria a saga dentro da transação do chamador (nunca abre a própria). */
  async iniciar(
    osId: string,
    correlationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<SagaComPassos> {
    const decisao = decidirInicio(new Date(), process.env);
    const passos = decisao.passos.map(adiarPassoDoDiagnostico);

    const saga = await this.repo.criar(
      {
        osId,
        tipo: TIPO_SAGA_OS,
        correlationId,
        status: decisao.status,
        passos: passos.map(paraCriacao),
      },
      tx,
    );
    await this.outbox.append(
      tx,
      paraEventos(saga, decisao.comandos, { eventId: null }),
    );
    return saga;
  }

  /** correlationId da saga da OS, ou undefined quando não há saga. */
  async obterCorrelationIdDaOs(osId: string): Promise<string | undefined> {
    const saga = await this.repo.buscarPorOs(osId, TIPO_SAGA_OS);
    return saga?.correlationId;
  }

  /**
   * Dispara o passo GERAR_ORCAMENTO (PENDENTE -> EM_ANDAMENTO, com timer) na
   * transação do chamador. Retorna as transições (a emitir após o commit do
   * chamador) ou null quando não havia o que disparar.
   */
  async registrarDiagnosticoConcluido(
    osId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TransicoesSaga | null> {
    const saga = await this.repo.buscarPorOs(osId, TIPO_SAGA_OS, tx);
    if (!saga) {
      this.logger.warn(`saga da OS ${osId} não encontrada`);
      return null;
    }
    if (saga.status !== 'EM_ANDAMENTO') {
      this.logger.warn(`saga ${saga.id} em status ${saga.status}`);
      return null;
    }
    const passo = saga.passos.find(
      (p) => p.nome === PASSO_INICIADO_NO_DIAGNOSTICO,
    );
    if (!passo || passo.status !== 'PENDENTE') {
      this.logger.warn(
        `saga ${saga.id}: passo ${PASSO_INICIADO_NO_DIAGNOSTICO} não está pendente`,
      );
      return null;
    }

    const count = await this.repo.atualizarPassoSeStatus(
      passo.id,
      'PENDENTE',
      {
        status: 'EM_ANDAMENTO',
        expiraEm: new Date(
          Date.now() +
            timeoutPadraoMs(PASSO_INICIADO_NO_DIAGNOSTICO, process.env),
        ),
        incrementarTentativas: true,
      },
      tx,
    );
    if (count === 0) {
      this.logger.warn(`saga ${saga.id}: passo mudou durante o diagnóstico`);
      return null;
    }
    return {
      sagaId: saga.id,
      osId: saga.osId,
      correlationId: saga.correlationId,
      passos: [
        {
          passo: passo.nome,
          ordem: passo.ordem,
          statusAnterior: 'PENDENTE',
          statusNovo: 'EM_ANDAMENTO',
        },
      ],
    };
  }

  async aplicarEvento(
    evento: string,
    envelope: EnvelopeEventoSaga,
    tx?: Prisma.TransactionClient,
  ): Promise<ResultadoAplicacaoSaga> {
    const trabalho = (c: Prisma.TransactionClient) =>
      this.aplicarNaTransacao(evento, envelope, c);
    // O chamador é dono do commit e emite (SagaEventHandler via ctx.afterCommit).
    if (tx) return trabalho(tx);
    const resultado = await this.prisma.$transaction(trabalho);
    if (resultado.encontrada) this.emitirTransicoes(resultado.transicoes);
    return resultado;
  }

  /**
   * Time-out de passos: expira os passos EM_ANDAMENTO cujo `expira_em` já
   * passou (passo -> COMPENSADO, saga -> COMPENSADA, evento
   * `saga.passo.expirado` no outbox). Não altera a OS. Processa no máximo
   * `limite` passos por chamada, todos em uma única transação.
   *
   * Seguro com várias réplicas: `FOR UPDATE SKIP LOCKED` faz cada passo
   * vencido ser pego por uma só réplica; quem chega depois pula as linhas
   * travadas. A escrita ainda é condicional (`atualizarPassoSeStatus`), então
   * um evento da saga que concluiu o passo no meio do caminho vence o
   * time-out (count 0 -> passo pulado com aviso).
   *
   * Erro em qualquer passo propaga e reverte o lote inteiro (nada fica pela
   * metade); o próximo tick tenta de novo. Público para ser testado sem timer.
   *
   * As métricas de transição são emitidas só depois do commit do lote; em
   * rollback nada é emitido.
   */
  async expirarVencidos(
    agora: Date = new Date(),
    limite: number = LIMITE_EXPIRACAO_PADRAO,
  ): Promise<ResultadoExpiracao> {
    const lote = await this.prisma.$transaction(
      async (tx) => {
        const vencidos = await tx.$queryRaw<PassoVencido[]>`
          SELECT id, saga_id AS "sagaId"
          FROM saga_passos
          WHERE status = 'EM_ANDAMENTO' AND expira_em <= ${agora}
          ORDER BY expira_em
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED`;

        const transicoes: TransicoesSaga[] = [];
        for (const vencido of vencidos) {
          const t = await this.expirarPasso(vencido, agora, tx);
          if (t) transicoes.push(t);
        }
        return transicoes;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    lote.forEach((t) => this.emitirTransicoes(t));
    return { expirados: lote.length };
  }

  private async expirarPasso(
    vencido: PassoVencido,
    agora: Date,
    tx: Prisma.TransactionClient,
  ): Promise<TransicoesSaga | null> {
    const saga = await this.repo.buscarPorId(vencido.sagaId, tx);
    if (!saga) {
      this.logger.warn(
        `saga ${vencido.sagaId} do passo vencido ${vencido.id} não encontrada`,
      );
      return null;
    }

    const decisao = decidirExpiracao(paraSnapshot(saga), agora);
    if (decisao.tipo === 'IGNORAR') return null;

    const [alterado] = decisao.passosAlterados;
    const count = await this.repo.atualizarPassoSeStatus(
      vencido.id,
      'EM_ANDAMENTO',
      {
        status: alterado.status,
        expiraEm: alterado.expiraEm,
        erro: decisao.motivo,
      },
      tx,
    );
    if (count === 0) {
      this.logger.warn(
        `saga ${saga.id}: passo ${vencido.id} mudou antes de expirar`,
      );
      return null;
    }

    await this.repo.atualizarStatusSaga(
      saga.id,
      decisao.novoStatusSaga,
      agora,
      tx,
    );
    await this.outbox.append(
      tx,
      paraEventos(saga, decisao.comandos, { eventId: null }),
    );
    this.logger.log(
      `saga ${saga.id}: passo ${alterado.nome} expirado e compensado`,
    );
    return {
      sagaId: saga.id,
      osId: saga.osId,
      correlationId: saga.correlationId,
      passos: [
        {
          passo: alterado.nome,
          ordem: alterado.ordem,
          statusAnterior: 'EM_ANDAMENTO',
          statusNovo: 'EXPIRADO',
        },
        {
          passo: alterado.nome,
          ordem: alterado.ordem,
          statusAnterior: 'EXPIRADO',
          statusNovo: alterado.status,
        },
      ],
      saga: transicaoSaga(saga.status, decisao.novoStatusSaga),
    };
  }

  private async carregar(
    envelope: EnvelopeEventoSaga,
    c: Prisma.TransactionClient,
  ): Promise<SagaComPassos | null> {
    if (envelope.osId) {
      const porOs = await this.repo.buscarPorOs(envelope.osId, TIPO_SAGA_OS, c);
      if (porOs) return porOs;
    }
    if (envelope.correlationId) {
      return this.repo.buscarPorCorrelationId(envelope.correlationId, c);
    }
    return null;
  }

  private async aplicarNaTransacao(
    evento: string,
    envelope: EnvelopeEventoSaga,
    c: Prisma.TransactionClient,
  ): Promise<ResultadoAplicacaoSaga> {
    const saga = await this.carregar(envelope, c);
    if (!saga) {
      const motivo = `saga não encontrada para ${evento} (osId=${envelope.osId}, correlationId=${envelope.correlationId})`;
      this.logger.warn(motivo);
      return { encontrada: false, motivo };
    }

    const agora = new Date();
    const decisao = decidirEvento(
      paraSnapshot(saga),
      evento,
      agora,
      process.env,
    );
    const resultado = (
      d: DecisaoSaga,
      passos: TransicaoPassoSaga[],
    ): ResultadoAplicacaoSaga => ({
      encontrada: true,
      sagaId: saga.id,
      osId: saga.osId,
      decisao: d,
      transicoes: {
        sagaId: saga.id,
        osId: saga.osId,
        correlationId: saga.correlationId,
        passos,
        saga: transicaoSaga(saga.status, d.novoStatusSaga),
      },
    });

    if (decisao.tipo === 'IGNORAR' || decisao.tipo === 'PROGRESSO') {
      this.logger.log(
        `saga ${saga.id}: ${evento} -> ${decisao.tipo} ${decisao.motivo ?? ''}`.trim(),
      );
      return resultado(decisao, []);
    }

    const passosEmitidos: TransicaoPassoSaga[] = [];
    for (let i = 0; i < decisao.passosAlterados.length; i++) {
      const alterado = decisao.passosAlterados[i];
      const atual = saga.passos.find((p) => p.ordem === alterado.ordem);
      if (!atual) {
        throw new Error(
          `passo ${alterado.ordem} inexistente na saga ${saga.id}`,
        );
      }

      const count = await this.repo.atualizarPassoSeStatus(
        atual.id,
        atual.status,
        {
          status: alterado.status,
          expiraEm: alterado.expiraEm,
          erro: decisao.tipo === 'COMPENSAR' ? decisao.motivo : undefined,
          incrementarTentativas: alterado.tentativas > atual.tentativas,
        },
        c,
      );
      if (count === 0 && i === 0) {
        const motivo = `concorrência: passo ${alterado.ordem} da saga ${saga.id} já mudou`;
        this.logger.warn(motivo);
        return resultado(
          {
            tipo: 'IGNORAR',
            passosAlterados: [],
            comandos: [],
            novoStatusSaga: saga.status,
            motivo,
          },
          [],
        );
      }
      if (count === 0) throw new SagaConcorrenciaError(saga.id, alterado.ordem);
      passosEmitidos.push({
        passo: alterado.nome,
        ordem: alterado.ordem,
        statusAnterior: atual.status,
        statusNovo: alterado.status,
      });
    }

    if (decisao.novoStatusSaga !== saga.status) {
      await this.repo.atualizarStatusSaga(
        saga.id,
        decisao.novoStatusSaga,
        STATUS_TERMINAIS.has(decisao.novoStatusSaga) ? agora : undefined,
        c,
      );
    }
    await this.outbox.append(
      c,
      paraEventos(saga, decisao.comandos, {
        eventId: envelope.eventId,
        traceparent: envelope.traceparent,
      }),
    );
    return resultado(decisao, passosEmitidos);
  }
}
