// O alias `src/` não é resolvido pelo Jest deste projeto; PrismaService só é token de DI.
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { OrdemDeServicoPrismaRepository } from './service-orders-prisma.repository';
import { PrismaService } from 'src/prisma/prisma.service';
import { OutboxWriter } from '../../../../shared/messaging/outbox.writer';
import { DomainEvent } from '../../../../shared/messaging/domain-event';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';

const NOW = new Date('2024-01-01');

const rawOs = {
  id: 'os-1',
  numero: 'OS-1',
  clienteId: 'c-1',
  veiculoId: 'v-1',
  status: 'RECEBIDA',
  arquivada: false,
  descricaoProblema: null,
  dataAbertura: NOW,
  dataFechamento: null,
  createdAt: NOW,
  updatedAt: NOW,
  osItensServico: [],
  osItensPeca: [],
  historicoStatus: [],
};

const makeOs = (): OrdemDeServico =>
  OrdemDeServico.restore({
    id: 'os-1',
    numero: 'OS-1',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    status: StatusOS.RECEBIDA,
    arquivada: false,
    servicos: [
      {
        id: 's-1',
        servicoId: 'svc-1',
        precoUnitario: 10,
        status: 'pendente',
      },
    ],
    pecas: [
      {
        id: 'p-1',
        pecaId: 'peca-1',
        quantidade: 1,
        valorUnitario: 5,
        status: 'utilizada',
      },
    ],
    historicoStatus: [],
    dataAbertura: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

const event: DomainEvent = {
  evento: 'os.criada',
  aggregateType: 'OrdemDeServico',
  aggregateId: 'os-1',
  payload: { numero: 'OS-1' },
  correlationId: 'corr-1',
};

function setup() {
  const calls: string[] = [];
  const track = (name: string, value: unknown = undefined) =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });

  const tx = {
    ordemDeServico: {
      create: track('os.create', rawOs),
      update: track('os.update'),
    },
    historicoStatusOS: { createMany: track('historico.createMany') },
    osItemServico: {
      deleteMany: track('servico.deleteMany'),
      createMany: track('servico.createMany'),
    },
    osItemPeca: {
      deleteMany: track('peca.deleteMany'),
      createMany: track('peca.createMany'),
    },
    outbox: { createMany: track('outbox.createMany') },
  };

  let txCallbacks = 0;
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => {
        txCallbacks++;
        calls.push('tx.begin');
        const result = await cb(tx);
        calls.push('tx.commit');
        return result;
      }),
    ordemDeServico: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(rawOs),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const repo = new OrdemDeServicoPrismaRepository(
    prisma as unknown as PrismaService,
    new OutboxWriter(),
  );
  return { repo, prisma, tx, calls, txCallbacks: () => txCallbacks };
}

describe('OrdemDeServicoPrismaRepository outbox integration', () => {
  describe('create()', () => {
    it('writes the OS and the events inside the same transaction callback', async () => {
      const { repo, prisma, tx, calls } = setup();

      const result = await repo.create(makeOs(), [event]);

      expect(result.id).toBe('os-1');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.ordemDeServico.create).not.toHaveBeenCalled();
      expect(tx.outbox.createMany).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([
        'tx.begin',
        'os.create',
        'outbox.createMany',
        'tx.commit',
      ]);
    });

    it('rejects when the outbox insert fails', async () => {
      const { repo, tx } = setup();
      tx.outbox.createMany.mockRejectedValue(new Error('outbox down'));

      await expect(repo.create(makeOs(), [event])).rejects.toThrow(
        'outbox down',
      );
    });

    it('does not touch the outbox when no events are given', async () => {
      const { repo, tx, calls } = setup();

      await repo.create(makeOs());

      expect(tx.outbox.createMany).not.toHaveBeenCalled();
      expect(calls).toEqual(['tx.begin', 'os.create', 'tx.commit']);
    });

    it('does not touch the outbox when events is an empty array', async () => {
      const { repo, tx } = setup();
      await repo.create(makeOs(), []);
      expect(tx.outbox.createMany).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('writes the OS changes and the events inside the same transaction callback', async () => {
      const { repo, prisma, tx, calls } = setup();

      await repo.update(makeOs(), [event]);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.ordemDeServico.update).toHaveBeenCalledTimes(1);
      expect(tx.outbox.createMany).toHaveBeenCalledTimes(1);
      expect(calls.indexOf('os.update')).toBeLessThan(
        calls.indexOf('outbox.createMany'),
      );
      expect(calls.indexOf('outbox.createMany')).toBeLessThan(
        calls.indexOf('tx.commit'),
      );
      expect(calls[0]).toBe('tx.begin');
    });

    it('rejects when the outbox insert fails', async () => {
      const { repo, tx, prisma } = setup();
      tx.outbox.createMany.mockRejectedValue(new Error('outbox down'));

      await expect(repo.update(makeOs(), [event])).rejects.toThrow(
        'outbox down',
      );
      expect(prisma.ordemDeServico.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('does not touch the outbox when no events are given', async () => {
      const { repo, tx } = setup();

      await repo.update(makeOs());

      expect(tx.ordemDeServico.update).toHaveBeenCalledTimes(1);
      expect(tx.outbox.createMany).not.toHaveBeenCalled();
    });

    it('skips child inserts when the OS has no services or parts', async () => {
      const { repo, tx } = setup();
      const os = OrdemDeServico.create({
        numero: 'OS-9',
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });

      await repo.update(os);

      expect(tx.osItemServico.createMany).not.toHaveBeenCalled();
      expect(tx.osItemPeca.createMany).not.toHaveBeenCalled();
    });
  });
});
