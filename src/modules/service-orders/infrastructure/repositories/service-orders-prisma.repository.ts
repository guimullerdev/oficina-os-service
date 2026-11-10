import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  IOrdemDeServicoRepository,
  IOrdemDeServicoRepositoryTransacional,
  TrabalhoNaTransacao,
} from '../../domain/repositories/service-orders.repository.interface';
import {
  OrdemDeServico,
  StatusOS,
  OsItemServico,
  OsItemPeca,
} from '../../domain/entities/service-orders.entity';
import { ServiceOrderMapper } from '../mappers/service-orders.mapper';
import { PrismaService } from 'src/prisma/prisma.service';
import { DomainEvent } from '../../../../shared/messaging/domain-event';
import { OutboxWriter } from '../../../../shared/messaging/outbox.writer';

const STATUS_PRIORITY: Partial<Record<StatusOS, number>> = {
  [StatusOS.EM_EXECUCAO]: 1,
  [StatusOS.AGUARDANDO_APROVACAO]: 2,
  [StatusOS.EM_DIAGNOSTICO]: 3,
  [StatusOS.RECEBIDA]: 4,
};

function byStatusPriorityThenOldest(
  a: OrdemDeServico,
  b: OrdemDeServico,
): number {
  const pa = STATUS_PRIORITY[a.status] ?? 99;
  const pb = STATUS_PRIORITY[b.status] ?? 99;
  if (pa !== pb) return pa - pb;
  return a.dataAbertura.getTime() - b.dataAbertura.getTime();
}

const includeItems = {
  osItensServico: true,
  osItensPeca: true,
  historicoStatus: { orderBy: { data: 'asc' } },
} as const;

@Injectable()
export class OrdemDeServicoPrismaRepository
  implements IOrdemDeServicoRepository, IOrdemDeServicoRepositoryTransacional
{
  constructor(
    private prisma: PrismaService,
    private outboxWriter: OutboxWriter,
  ) {}

  async findById(id: string): Promise<OrdemDeServico | null> {
    const raw = await this.prisma.ordemDeServico.findUnique({
      where: { id },
      include: includeItems,
    });
    if (!raw) return null;
    return ServiceOrderMapper.toDomain(raw);
  }

  async findAll(filters?: {
    status?: StatusOS;
    clienteId?: string;
    veiculoId?: string;
    incluirArquivadas?: boolean;
  }): Promise<OrdemDeServico[]> {
    const raws = await this.prisma.ordemDeServico.findMany({
      where: {
        ...(filters?.status ? { status: filters.status as any } : {}),
        ...(filters?.clienteId ? { clienteId: filters.clienteId } : {}),
        ...(filters?.veiculoId ? { veiculoId: filters.veiculoId } : {}),
        ...(filters?.incluirArquivadas ? {} : { arquivada: false }),
      },
      include: includeItems,
      orderBy: { dataAbertura: 'asc' },
    });
    return raws
      .map(ServiceOrderMapper.toDomain)
      .sort(byStatusPriorityThenOldest);
  }

  async create(
    os: OrdemDeServico,
    events: DomainEvent[] = [],
    naTransacao?: TrabalhoNaTransacao,
  ): Promise<OrdemDeServico> {
    const raw = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ordemDeServico.create({
        data: {
          ...ServiceOrderMapper.toPrisma(os),
          // A OS nasce com o registro do status inicial (RECEBIDA), que
          // é o marco a partir do qual a primeira transição é medida.
          historicoStatus: {
            createMany: {
              data: ServiceOrderMapper.historicoToPrisma(os).map(
                ({ osId: _osId, ...linha }) => linha,
              ),
            },
          },
        },
        include: includeItems,
      });

      await this.outboxWriter.append(tx, events);
      if (naTransacao) await naTransacao(tx);
      return created;
    });
    return ServiceOrderMapper.toDomain(raw);
  }

  async update(
    os: OrdemDeServico,
    events: DomainEvent[] = [],
    naTransacao?: TrabalhoNaTransacao,
  ): Promise<OrdemDeServico> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ordemDeServico.update({
        where: { id: os.id },
        data: {
          status: os.status as any,
          arquivada: os.arquivada,
          descricaoProblema: os.descricaoProblema ?? null,
          dataFechamento: os.dataFechamento ?? null,
          updatedAt: os.updatedAt,
        },
      });

      // `skipDuplicates` pela PK: as entradas já persistidas são
      // ignoradas e só a transição nova é inserida, sem precisar
      // comparar listas à mão.
      const historico = ServiceOrderMapper.historicoToPrisma(os);
      if (historico.length > 0) {
        await tx.historicoStatusOS.createMany({
          data: historico,
          skipDuplicates: true,
        });
      }

      // Sync OsItensServico
      await tx.osItemServico.deleteMany({ where: { osId: os.id } });
      if (os.servicos.length > 0) {
        await tx.osItemServico.createMany({
          data: os.servicos.map((s: OsItemServico) => ({
            id: s.id,
            osId: os.id,
            servicoId: s.servicoId,
            precoUnitario: new Prisma.Decimal(s.precoUnitario),
            inicioExec: s.inicioExec ?? null,
            fimExec: s.fimExec ?? null,
          })),
        });
      }

      // Sync OsItensPeca
      await tx.osItemPeca.deleteMany({ where: { osId: os.id } });
      if (os.pecas.length > 0) {
        await tx.osItemPeca.createMany({
          data: os.pecas.map((p: OsItemPeca) => ({
            id: p.id,
            osId: os.id,
            pecaId: p.pecaId,
            quantidade: p.quantidade,
            precoUnitario: new Prisma.Decimal(p.valorUnitario),
            utilizada: p.status === 'utilizada',
          })),
        });
      }

      await this.outboxWriter.append(tx, events);
      if (naTransacao) await naTransacao(tx);
    });

    const updated = await this.prisma.ordemDeServico.findUniqueOrThrow({
      where: { id: os.id },
      include: includeItems,
    });
    return ServiceOrderMapper.toDomain(updated);
  }

  async findByIdInTx(id: string, tx: unknown): Promise<OrdemDeServico | null> {
    const raw = await (
      tx as Prisma.TransactionClient
    ).ordemDeServico.findUnique({ where: { id }, include: includeItems });
    return raw ? ServiceOrderMapper.toDomain(raw) : null;
  }

  async updateStatusInTx(
    os: OrdemDeServico,
    statusEsperado: StatusOS,
    tx: unknown,
  ): Promise<boolean> {
    const client = tx as Prisma.TransactionClient;
    // Guarda otimista pelo status atual: se outro fluxo já moveu a OS, não grava nada.
    const { count } = await client.ordemDeServico.updateMany({
      where: { id: os.id, status: statusEsperado as any },
      data: { status: os.status as any, updatedAt: os.updatedAt },
    });
    if (count === 0) return false;

    await client.historicoStatusOS.createMany({
      data: ServiceOrderMapper.historicoToPrisma(os),
      skipDuplicates: true,
    });
    return true;
  }

  async generateNumero(): Promise<string> {
    const count = await this.prisma.ordemDeServico.count();
    const seq = String(count + 1).padStart(6, '0');
    const year = new Date().getFullYear();
    return `OS-${year}-${seq}`;
  }
}
