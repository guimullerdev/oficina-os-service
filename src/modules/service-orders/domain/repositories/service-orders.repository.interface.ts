import { OrdemDeServico, StatusOS } from '../entities/service-orders.entity';
import { DomainEvent } from '../../../../shared/messaging/domain-event';

export interface IOrdemDeServicoRepository {
    findById(id: string): Promise<OrdemDeServico | null>;
    findAll(filters?: { status?: StatusOS; clienteId?: string; veiculoId?: string; incluirArquivadas?: boolean }): Promise<OrdemDeServico[]>;
    create(os: OrdemDeServico, events?: DomainEvent[]): Promise<OrdemDeServico>;
    update(os: OrdemDeServico, events?: DomainEvent[]): Promise<OrdemDeServico>;
    generateNumero(): Promise<string>;
}

export const ORDEM_DE_SERVICO_REPOSITORY = Symbol('IOrdemDeServicoRepository');
