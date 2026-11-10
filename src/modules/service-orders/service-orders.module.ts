import { OsStatusMetrics } from './application/os-status-metrics.service';
import { Module } from '@nestjs/common';

import { PrismaModule } from 'src/prisma/prisma.module';
import { OutboxWriter } from '../../shared/messaging/outbox.writer';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { CustomersModule } from '../customers/customers.module';

import { ORDEM_DE_SERVICO_REPOSITORY } from './domain/repositories/service-orders.repository.interface';
import { OrdemDeServicoPrismaRepository } from './infrastructure/repositories/service-orders-prisma.repository';
import { ServiceOrdersController } from './presentation/service-orders.controller';

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

@Module({
    imports: [PrismaModule, VehiclesModule, CustomersModule],
    controllers: [ServiceOrdersController],
    providers: [
        OsStatusMetrics,
        OutboxWriter,
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
        {
            provide: ORDEM_DE_SERVICO_REPOSITORY,
            useClass: OrdemDeServicoPrismaRepository,
        },
    ],
    exports: [ORDEM_DE_SERVICO_REPOSITORY],
})
export class ServiceOrdersModule {}
