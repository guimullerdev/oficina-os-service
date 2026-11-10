import { OrdemDeServico, StatusOS } from '../entities/service-orders.entity';
import { DomainEvent } from '../../../../shared/messaging/domain-event';

/** Trabalho extra executado dentro da mesma transação da escrita da OS. */
export type TrabalhoNaTransacao = (tx: unknown) => Promise<unknown>;

export interface IOrdemDeServicoRepository {
    findById(id: string): Promise<OrdemDeServico | null>;
    findAll(filters?: { status?: StatusOS; clienteId?: string; veiculoId?: string; incluirArquivadas?: boolean }): Promise<OrdemDeServico[]>;
    create(os: OrdemDeServico, events?: DomainEvent[], naTransacao?: TrabalhoNaTransacao): Promise<OrdemDeServico>;
    update(os: OrdemDeServico, events?: DomainEvent[], naTransacao?: TrabalhoNaTransacao): Promise<OrdemDeServico>;
    generateNumero(): Promise<string>;
}

export const ORDEM_DE_SERVICO_REPOSITORY = Symbol('IOrdemDeServicoRepository');
