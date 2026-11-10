import { Logger } from '@nestjs/common';

import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import type { IOrdemDeServicoRepositoryTransacional } from '../../domain/repositories/service-orders.repository.interface';
import type { OsStatusMetrics } from '../os-status-metrics.service';
import type { AoCompensar } from './handlers/saga-event.handler';
import type { Compensacao } from './saga-definicao';

type MetricasTransicao = Pick<OsStatusMetrics, 'registrarTransicao'>;

/**
 * A OS mudou de status entre a leitura e a escrita da compensação. Propaga
 * para a mensagem ser reentregue e a decisão reavaliada no novo estado.
 */
export class OsCompensacaoConcorrenciaError extends Error {
  constructor(
    readonly osId: string,
    readonly statusEsperado: StatusOS,
  ) {
    super(
      `concorrência na compensação da OS ${osId}: status deixou de ser ${statusEsperado}`,
    );
    this.name = 'OsCompensacaoConcorrenciaError';
  }
}

interface RegraCompensacao {
  /** Único status a partir do qual a compensação é aplicada. */
  readonly origem: StatusOS;
  /** Status resultante; a OS já estar nele significa compensação já aplicada. */
  readonly alvo: StatusOS;
  readonly transicionar: (os: OrdemDeServico) => OrdemDeServico;
}

export const REGRAS_COMPENSACAO: Readonly<
  Record<Exclude<Compensacao, 'PAGAMENTO_PENDENTE'>, RegraCompensacao>
> = {
  OS_REPROVADA: {
    origem: StatusOS.AGUARDANDO_APROVACAO,
    alvo: StatusOS.REPROVADA,
    transicionar: (os) => os.reprovarOrcamento(),
  },
  OS_VOLTA_APROVADA: {
    origem: StatusOS.EM_EXECUCAO,
    alvo: StatusOS.APROVADA,
    transicionar: (os) => os.compensarFalhaExecucao(),
  },
};

/**
 * Aplica na OS a compensação decidida pela saga, dentro da transação do
 * processador idempotente (a mesma que gravou o passo da saga). Idempotente:
 * reentregas encontram a OS já compensada e viram no-op. Estado divergente do
 * esperado é ignorado com aviso (não lança), exceto perda de corrida na
 * escrita, que propaga para reprocessar.
 */
export class SagaCompensador {
  private readonly logger = new Logger(SagaCompensador.name);

  constructor(
    private readonly repo: IOrdemDeServicoRepositoryTransacional,
    private readonly metrics: MetricasTransicao,
  ) {}

  readonly aoCompensar: AoCompensar = async (resultado, message, tx) => {
    const { sagaId, osId, decisao } = resultado;
    const compensacao = decisao.compensacao;
    if (decisao.tipo !== 'COMPENSAR' || !compensacao) return;

    if (compensacao === 'PAGAMENTO_PENDENTE') {
      this.logger.warn(
        `saga ${sagaId}: pagamento recusado; OS ${osId} mantida (saga PENDENTE) messageId=${message.messageId}`,
      );
      return;
    }

    if (!tx) {
      throw new Error(
        `compensação ${compensacao} exige a transação do processador (saga ${sagaId})`,
      );
    }

    const regra = REGRAS_COMPENSACAO[compensacao];
    const os = await this.repo.findByIdInTx(osId, tx);
    if (!os) {
      this.logger.warn(
        `saga ${sagaId}: compensação ${compensacao} ignorada; OS ${osId} não encontrada`,
      );
      return;
    }

    if (os.status === regra.alvo) {
      this.logger.log(
        `saga ${sagaId}: compensação ${compensacao} já aplicada; OS ${osId} em ${os.status} (no-op)`,
      );
      return;
    }

    if (os.status !== regra.origem) {
      this.logger.warn(
        `saga ${sagaId}: compensação ${compensacao} ignorada; OS ${osId} em ${os.status} (esperado ${regra.origem})`,
      );
      return;
    }

    const compensada = regra.transicionar(os);
    const gravada = await this.repo.updateStatusInTx(
      compensada,
      regra.origem,
      tx,
    );
    if (!gravada) throw new OsCompensacaoConcorrenciaError(osId, regra.origem);

    this.logger.log(
      `saga ${sagaId}: compensação ${compensacao} aplicada; OS ${osId} ${regra.origem} → ${regra.alvo}`,
    );
    this.metrics.registrarTransicao(compensada, message.correlationId);
  };
}
