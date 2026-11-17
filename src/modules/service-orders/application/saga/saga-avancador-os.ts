import { Logger } from '@nestjs/common';

import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import type { IOrdemDeServicoRepositoryTransacional } from '../../domain/repositories/service-orders.repository.interface';
import type { OsStatusMetrics } from '../os-status-metrics.service';
import type { AoAvancar } from './handlers/saga-event.handler';
import { EVENTOS_SAGA } from './saga-definicao';
import type { TipoDecisao } from './saga-maquina';

type MetricasTransicao = Pick<OsStatusMetrics, 'registrarTransicao'>;

/**
 * A OS mudou de status entre a leitura e a escrita do avanço. Propaga para a
 * mensagem ser reentregue e a decisão reavaliada no novo estado.
 */
export class OsAvancoConcorrenciaError extends Error {
  constructor(
    readonly osId: string,
    readonly statusEsperado: StatusOS,
  ) {
    super(
      `concorrência no avanço da OS ${osId}: status deixou de ser ${statusEsperado}`,
    );
    this.name = 'OsAvancoConcorrenciaError';
  }
}

interface PassoAvanco {
  readonly origem: StatusOS;
  readonly transicionar: (os: OrdemDeServico) => OrdemDeServico;
}

interface RegraAvanco {
  /** Decisões da saga em que o evento move a OS (as demais são ignoradas). */
  readonly decisoes: readonly TipoDecisao[];
  /** Status final; a OS já estar nele significa avanço já aplicado. */
  readonly alvo: StatusOS;
  /**
   * Transições em ordem. A OS entra na cadeia pelo passo cuja origem é o seu
   * status atual e aplica o restante (recupera um evento intermediário perdido).
   */
  readonly cadeia: readonly PassoAvanco[];
}

const APROVAR: PassoAvanco = {
  origem: StatusOS.AGUARDANDO_APROVACAO,
  transicionar: (os) => os.aprovarOrcamento(),
};
const INICIAR: PassoAvanco = {
  origem: StatusOS.APROVADA,
  transicionar: (os) => os.iniciarExecucao(),
};
const FINALIZAR: PassoAvanco = {
  origem: StatusOS.EM_EXECUCAO,
  transicionar: (os) => os.finalizarExecucao(),
};

/** Eventos de sucesso da saga que movem a OS. ENTREGUE segue manual. */
export const REGRAS_AVANCO: Readonly<Record<string, RegraAvanco>> = {
  [EVENTOS_SAGA.ORCAMENTO_APROVADO]: {
    decisoes: ['AVANCAR'],
    alvo: StatusOS.APROVADA,
    cadeia: [APROVAR],
  },
  [EVENTOS_SAGA.EXECUCAO_INICIADA]: {
    decisoes: ['PROGRESSO'],
    alvo: StatusOS.EM_EXECUCAO,
    cadeia: [INICIAR],
  },
  [EVENTOS_SAGA.EXECUCAO_CONCLUIDA]: {
    decisoes: ['AVANCAR'],
    alvo: StatusOS.FINALIZADA,
    cadeia: [INICIAR, FINALIZAR],
  },
};

/**
 * Move a OS junto com o passo da saga no caminho feliz, na transação do
 * processador idempotente. Só age quando a saga de fato avançou/progrediu com
 * o evento (duplicadas e fora de ordem viram IGNORAR e não chegam a gravar).
 * Idempotente: OS já no status alvo é no-op. Estado divergente é ignorado com
 * aviso (não lança, para não gerar reentrega infinita), exceto perda de corrida
 * na escrita, que propaga para reprocessar. A métrica `os.status.transicao` só
 * sai após o commit (`ctx.afterCommit`), uma por transição aplicada.
 */
export class SagaAvancadorOs {
  private readonly logger = new Logger(SagaAvancadorOs.name);

  constructor(
    private readonly repo: IOrdemDeServicoRepositoryTransacional,
    private readonly metrics: MetricasTransicao,
  ) {}

  readonly aoAvancar: AoAvancar = async (resultado, message, tx, ctx) => {
    const { sagaId, osId, decisao } = resultado;
    const regra = REGRAS_AVANCO[message.evento];
    if (!regra || !regra.decisoes.includes(decisao.tipo)) return;

    if (!tx) {
      throw new Error(
        `avanço da OS por ${message.evento} exige a transação do processador (saga ${sagaId})`,
      );
    }

    const os = await this.repo.findByIdInTx(osId, tx);
    if (!os) {
      this.logger.warn(
        `saga ${sagaId}: avanço por ${message.evento} ignorado; OS ${osId} não encontrada`,
      );
      return;
    }

    if (os.status === regra.alvo) {
      this.logger.log(
        `saga ${sagaId}: avanço por ${message.evento} já aplicado; OS ${osId} em ${os.status} (no-op)`,
      );
      return;
    }

    const inicio = regra.cadeia.findIndex((p) => p.origem === os.status);
    if (inicio < 0) {
      this.logger.warn(
        `saga ${sagaId}: avanço por ${message.evento} ignorado; OS ${osId} em ${os.status} (esperado ${regra.cadeia[0].origem})`,
      );
      return;
    }

    const aplicadas: OrdemDeServico[] = [];
    let atual = os;
    for (const passo of regra.cadeia.slice(inicio)) {
      atual = passo.transicionar(atual);
      aplicadas.push(atual);
    }

    const gravada = await this.repo.updateStatusInTx(atual, os.status, tx);
    if (!gravada) throw new OsAvancoConcorrenciaError(osId, os.status);

    this.logger.log(
      `saga ${sagaId}: avanço por ${message.evento} aplicado; OS ${osId} ${os.status} → ${atual.status}`,
    );
    // Metric only after commit: on rollback the transition did not happen.
    for (const transicionada of aplicadas) {
      ctx?.afterCommit(() =>
        this.metrics.registrarTransicao(transicionada, message.correlationId),
      );
    }
  };
}
