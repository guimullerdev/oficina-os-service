import { OsStatusMetrics } from './application/os-status-metrics.service';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { MessagingModule } from '../../shared/messaging/messaging.module';
import { MessageHandlerRegistry } from '../../shared/messaging/handlers/message-handler.registry';
import { criarSagaEventHandlers } from './application/saga/handlers/saga-event.handler';
import { OutboxWriter } from '../../shared/messaging/outbox.writer';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { CustomersModule } from '../customers/customers.module';

import {
    IOrdemDeServicoRepositoryTransacional,
    ORDEM_DE_SERVICO_REPOSITORY,
} from './domain/repositories/service-orders.repository.interface';
import { OrdemDeServicoPrismaRepository } from './infrastructure/repositories/service-orders-prisma.repository';
import { ServiceOrdersController } from './presentation/service-orders.controller';
import { SagaOrchestrator } from './application/saga/saga-orchestrator.service';
import { SagaCompensador } from './application/saga/saga-compensador';
import { SagaTimeoutScheduler } from './application/saga/saga-timeout.scheduler';
import { SagaPrismaRepository } from './application/saga/saga.repository';

import { CreateOrdemDeServicoUseCase } from './application/use-cases/create-service-orders.usecase';
import { GetOrdemDeServicoUseCase } from './application/use-cases/get-service-orders.usecase';
import { UpdateOrdemDeServicoUseCase } from './application/use-cases/update-service-orders.usecase';
import { DeleteOrdemDeServicoUseCase } from './application/use-cases/delete-service-orders.usecase';
import { AddServicoToOsUseCase } from './application/use-cases/add-service-to-order.usecase';
import { RemoveServicoFromOsUseCase } from './application/use-cases/remove-service-from-order.usecase';
import { AddPecaToOsUseCase } from './application/use-cases/add-part-to-order.usecase';
import { RemovePecaFromOsUseCase } from './application/use-cases/remove-part-from-order.usecase';
import { StartDiagnosisUseCase } from './application/use-cases/start-diagnosis.usecase';
import { FinishDiagnosisUseCase } from './application/use-cases/finish-diagnosis.usecase';
import { IniciarExecucaoUseCase } from './application/use-cases/iniciar-execucao.usecase';
import { RealizarServicoUseCase } from './application/use-cases/realizar-servico.usecase';
import { UtilizarPecaUseCase } from './application/use-cases/utilizar-peca.usecase';
import { FinishOrderUseCase } from './application/use-cases/finish-order.usecase';
import { LiberarVeiculoUseCase } from './application/use-cases/liberar-veiculo.usecase';
import { DeliverOrderUseCase } from './application/use-cases/deliver-order.usecase';
import { SendBudgetUseCase } from './application/use-cases/send-budget.usecase';
import { ApproveBudgetUseCase } from './application/use-cases/approve-budget.usecase';
import { RejectBudgetUseCase } from './application/use-cases/reject-budget.usecase';

import { GetOsAcompanhamentoUseCase } from './application/use-cases/get-os-acompanhamento.usecase';
import { GetTempoMedioOsUseCase } from './application/use-cases/get-tempo-medio-os.usecase';
import { ConsultaPublicaOsUseCase } from './application/use-cases/consulta-publica-os.usecase';
import { ProcessarWebhookNotificacaoUseCase } from './application/use-cases/processar-webhook-notificacao.usecase';
import { GetSagaUseCase } from './application/saga/get-saga.usecase';

@Module({
    imports: [PrismaModule, VehiclesModule, CustomersModule, MessagingModule],
    controllers: [ServiceOrdersController],
    providers: [
        OsStatusMetrics,
        OutboxWriter,
        SagaPrismaRepository,
        {
            provide: SagaOrchestrator,
            useFactory: (prisma: PrismaService, repo: SagaPrismaRepository, outbox: OutboxWriter) =>
                new SagaOrchestrator(prisma, repo, outbox),
            inject: [PrismaService, SagaPrismaRepository, OutboxWriter],
        },
        CreateOrdemDeServicoUseCase,
        GetOrdemDeServicoUseCase,
        UpdateOrdemDeServicoUseCase,
        DeleteOrdemDeServicoUseCase,
        AddServicoToOsUseCase,
        RemoveServicoFromOsUseCase,
        AddPecaToOsUseCase,
        RemovePecaFromOsUseCase,
        StartDiagnosisUseCase,
        FinishDiagnosisUseCase,
        IniciarExecucaoUseCase,
        RealizarServicoUseCase,
        UtilizarPecaUseCase,
        FinishOrderUseCase,
        LiberarVeiculoUseCase,
        DeliverOrderUseCase,
        SendBudgetUseCase,
        ApproveBudgetUseCase,
        RejectBudgetUseCase,
        GetOsAcompanhamentoUseCase,
        GetTempoMedioOsUseCase,
        ConsultaPublicaOsUseCase,
        ProcessarWebhookNotificacaoUseCase,
        GetSagaUseCase,
        {
            // Expira passos de saga vencidos (SAGA_TIMEOUT_ENABLED); seguro com N réplicas (SKIP LOCKED).
            provide: SagaTimeoutScheduler,
            useFactory: (orchestrator: SagaOrchestrator, config: ConfigService) =>
                new SagaTimeoutScheduler(orchestrator, config),
            inject: [SagaOrchestrator, ConfigService],
        },
        {
            // Registra os handlers da saga na criação (antes de o consumidor SQS iniciar).
            provide: 'SAGA_EVENT_HANDLERS',
            useFactory: (
                registry: MessageHandlerRegistry,
                orchestrator: SagaOrchestrator,
                osRepo: IOrdemDeServicoRepositoryTransacional,
                metrics: OsStatusMetrics,
            ) => {
                const compensador = new SagaCompensador(osRepo, metrics);
                const handlers = criarSagaEventHandlers(orchestrator, compensador.aoCompensar);
                handlers.forEach((h) => registry.register(h));
                return handlers;
            },
            inject: [MessageHandlerRegistry, SagaOrchestrator, ORDEM_DE_SERVICO_REPOSITORY, OsStatusMetrics],
        },
        {
            provide: ORDEM_DE_SERVICO_REPOSITORY,
            useClass: OrdemDeServicoPrismaRepository,
        },
    ],
    exports: [ORDEM_DE_SERVICO_REPOSITORY, SagaOrchestrator],
})
export class ServiceOrdersModule {}
