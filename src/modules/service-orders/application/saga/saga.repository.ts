import { Injectable } from '@nestjs/common';
import { Prisma, SagaInstancia, StatusPassoSaga, StatusSaga } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';

const includePassos = {
    passos: { orderBy: { ordem: 'asc' } },
} as const;

export type SagaComPassos = Prisma.SagaInstanciaGetPayload<{ include: typeof includePassos }>;

export interface PassoSagaCriacao {
    ordem: number;
    nome: string;
    status: StatusPassoSaga;
    comando?: string | null;
    eventoEsperado?: string | null;
    expiraEm?: Date | null;
}

export interface SagaCriacao {
    osId: string;
    tipo: string;
    correlationId: string;
    status: StatusSaga;
    passos: PassoSagaCriacao[];
}

export interface AtualizacaoPasso {
    status: StatusPassoSaga;
    expiraEm?: Date | null;
    erro?: string | null;
    incrementarTentativas?: boolean;
}

@Injectable()
export class SagaPrismaRepository {
    constructor(private prisma: PrismaService) {}

    private cliente(tx?: Prisma.TransactionClient): Prisma.TransactionClient {
        return tx ?? this.prisma;
    }

    criar(dados: SagaCriacao, tx?: Prisma.TransactionClient): Promise<SagaComPassos> {
        return this.cliente(tx).sagaInstancia.create({
            data: {
                osId: dados.osId,
                tipo: dados.tipo,
                correlationId: dados.correlationId,
                status: dados.status,
                passos: { create: dados.passos },
            },
            include: includePassos,
        });
    }

    buscarPorOs(
        osId: string,
        tipo = 'ORDEM_DE_SERVICO',
        tx?: Prisma.TransactionClient,
    ): Promise<SagaComPassos | null> {
        return this.cliente(tx).sagaInstancia.findUnique({
            where: { osId_tipo: { osId, tipo } },
            include: includePassos,
        });
    }

    buscarPorCorrelationId(
        correlationId: string,
        tx?: Prisma.TransactionClient,
    ): Promise<SagaComPassos | null> {
        return this.cliente(tx).sagaInstancia.findFirst({
            where: { correlationId },
            include: includePassos,
        });
    }

    /**
     * Atualização condicional (lock otimista): só altera o passo se ele ainda
     * estiver no `statusEsperado`. Retorna quantas linhas foram afetadas (0 ou 1).
     */
    async atualizarPassoSeStatus(
        passoId: string,
        statusEsperado: StatusPassoSaga,
        dados: AtualizacaoPasso,
        tx?: Prisma.TransactionClient,
    ): Promise<number> {
        const { count } = await this.cliente(tx).sagaPasso.updateMany({
            where: { id: passoId, status: statusEsperado },
            data: {
                status: dados.status,
                expiraEm: dados.expiraEm,
                erro: dados.erro,
                ...(dados.incrementarTentativas ? { tentativas: { increment: 1 } } : {}),
            },
        });
        return count;
    }

    atualizarStatusSaga(
        sagaId: string,
        status: StatusSaga,
        finalizadaEm?: Date | null,
        tx?: Prisma.TransactionClient,
    ): Promise<SagaInstancia> {
        return this.cliente(tx).sagaInstancia.update({
            where: { id: sagaId },
            data: { status, finalizadaEm },
        });
    }

    async criarPassos(
        sagaId: string,
        passos: PassoSagaCriacao[],
        tx?: Prisma.TransactionClient,
    ): Promise<number> {
        const { count } = await this.cliente(tx).sagaPasso.createMany({
            data: passos.map((passo) => ({ ...passo, sagaId })),
        });
        return count;
    }
}
