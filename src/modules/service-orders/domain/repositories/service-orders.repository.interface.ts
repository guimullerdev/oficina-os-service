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

/**
 * Porta usada pela compensação da saga: opera sempre dentro da transação do
 * processador idempotente (`tx`), sem abrir transação própria nem reescrever
 * itens da OS.
 */
export interface IOrdemDeServicoRepositoryTransacional {
    findByIdInTx(id: string, tx: unknown): Promise<OrdemDeServico | null>;
    /** grava só status/updatedAt/histórico se status atual no banco === statusEsperado; false se não */
    updateStatusInTx(os: OrdemDeServico, statusEsperado: StatusOS, tx: unknown): Promise<boolean>;
}

export const ORDEM_DE_SERVICO_REPOSITORY = Symbol('IOrdemDeServicoRepository');
