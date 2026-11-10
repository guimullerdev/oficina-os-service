import { Prisma } from '@prisma/client';
import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ORDEM_DE_SERVICO_REPOSITORY, IOrdemDeServicoRepository } from '../../domain/repositories/service-orders.repository.interface';
import { InvalidTransitionError, OrdemDeServico } from '../../domain/entities/service-orders.entity';
import { DomainEvent } from '../../../../shared/messaging/domain-event';
import { SagaOrchestrator } from '../saga/saga-orchestrator.service';

@Injectable()
export class FinishDiagnosisUseCase {
    constructor(
        @Inject(ORDEM_DE_SERVICO_REPOSITORY)
        private readonly repo: IOrdemDeServicoRepository,
        private readonly sagaOrchestrator: SagaOrchestrator,
    ) {}

    async execute(id: string, ctx?: { correlationId?: string; traceparent?: string }): Promise<OrdemDeServico> {
        const os = await this.repo.findById(id);
        if (!os) throw new NotFoundException(`Ordem de serviço ${id} não encontrada`);

        let updated: OrdemDeServico;
        try {
            updated = os.concluirDiagnostico();
        } catch (err) {
            if (err instanceof InvalidTransitionError) throw new UnprocessableEntityException(err.message);
            throw err;
        }

        const evento: DomainEvent = {
            evento: 'diagnostico.concluido',
            aggregateType: 'ordem_de_servico',
            aggregateId: updated.id,
            payload: { id: updated.id, status: updated.status },
            correlationId: ctx?.correlationId ?? randomUUID(),
            traceparent: ctx?.traceparent,
        };

        return this.repo.update(updated, [evento], (tx) =>
            this.sagaOrchestrator.registrarDiagnosticoConcluido(updated.id, tx as Prisma.TransactionClient),
        );
    }
}
