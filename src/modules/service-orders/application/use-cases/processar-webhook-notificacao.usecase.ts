import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  ORDEM_DE_SERVICO_REPOSITORY,
  IOrdemDeServicoRepository,
} from '../../domain/repositories/service-orders.repository.interface';
import { OrdemDeServico, StatusOS } from '../../domain/entities/service-orders.entity';
import { WebhookAcao } from '../dto/webhook-notificacao.dto';
import { OsStatusMetrics } from '../os-status-metrics.service';

export type WebhookResultado =
  | 'APLICADA'
  | 'IGNORADA_IDEMPOTENTE'
  | 'REJEITADA';

export interface WebhookNotificacaoResult {
  resultado: WebhookResultado;
  osId: string;
  statusAtual: StatusOS;
  mensagem: string;
}

@Injectable()
export class ProcessarWebhookNotificacaoUseCase {
  private readonly logger = new Logger('WebhookAudit');

  constructor(
    @Inject(ORDEM_DE_SERVICO_REPOSITORY)
    private readonly osRepo: IOrdemDeServicoRepository,
    private readonly metrics: OsStatusMetrics,
  ) {}

  async execute(
    dto: { osId: string; acao: WebhookAcao; observacoes?: string },
    ip: string,
  ): Promise<WebhookNotificacaoResult> {
    const os = await this.osRepo.findById(dto.osId);
    if (!os)
      throw new NotFoundException(
        `Ordem de serviço ${dto.osId} não encontrada`,
      );

    const resultado = await this.processar(os, dto, ip);

    this.logger.log(
      JSON.stringify({
        osId: dto.osId,
        acao: dto.acao,
        resultado: resultado.resultado,
        observacoes: dto.observacoes,
        ip,
        timestamp: new Date().toISOString(),
      }),
    );

    return { ...resultado, osId: dto.osId };
  }

  private async processar(
    os: OrdemDeServico,
    dto: { osId: string; acao: WebhookAcao; observacoes?: string },
    ip: string,
  ): Promise<Omit<WebhookNotificacaoResult, 'osId'>> {
    const statusAtual = os.status;
    // Idempotency: ação já foi aplicada anteriormente
    if (
      (dto.acao === WebhookAcao.APROVAR && statusAtual === StatusOS.APROVADA) ||
      (dto.acao === WebhookAcao.REPROVAR && statusAtual === StatusOS.REPROVADA)
    ) {
      return {
        resultado: 'IGNORADA_IDEMPOTENTE',
        statusAtual: os.status,
        mensagem: `Ação ${dto.acao} já foi aplicada anteriormente. Nenhuma alteração realizada.`,
      };
    }

    // Só aceita ação se OS estiver aguardando aprovação
    if (statusAtual !== StatusOS.AGUARDANDO_APROVACAO) {
      this.logger.warn(
        JSON.stringify({
          osId: dto.osId,
          acao: dto.acao,
          resultado: 'REJEITADA',
          motivo: `Status inválido: ${statusAtual}`,
          ip,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new UnprocessableEntityException(
        `Não é possível ${dto.acao.toLowerCase()} orçamento: OS está em status ${statusAtual}. Esperado: AGUARDANDO_APROVACAO`,
      );
    }

    const atualizada =
      dto.acao === WebhookAcao.APROVAR
        ? os.aprovarOrcamento()
        : os.reprovarOrcamento();
    const salva = await this.osRepo.update(atualizada);
    // O interceptor não enxerga este caminho: a resposta do webhook não é uma
    // OrdemDeServico, então a métrica de transição é emitida aqui.
    this.metrics.registrarTransicao(salva);

    return {
      resultado: 'APLICADA',
      statusAtual: salva.status,
      mensagem:
        dto.acao === WebhookAcao.APROVAR
          ? 'Orçamento aprovado com sucesso.'
          : 'Orçamento reprovado com sucesso.',
    };
  }
}
