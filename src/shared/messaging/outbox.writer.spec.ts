import { Prisma } from '@prisma/client';
import { OutboxWriter } from './outbox.writer';
import { DomainEvent } from './domain-event';

const makeTx = () => ({
  outbox: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  evento: 'os.criada',
  aggregateType: 'OrdemDeServico',
  aggregateId: 'os-1',
  payload: { numero: 'OS-1' },
  correlationId: 'corr-1',
  ...over,
});

describe('OutboxWriter', () => {
  const writer = new OutboxWriter();

  it('does nothing when there are no events', async () => {
    const tx = makeTx();
    await writer.append(tx as unknown as Prisma.TransactionClient, []);
    expect(tx.outbox.createMany).not.toHaveBeenCalled();
  });

  it('inserts all events in a single createMany', async () => {
    const tx = makeTx();
    await writer.append(tx as unknown as Prisma.TransactionClient, [
      event(),
      event({ evento: 'os.atualizada', traceparent: '00-abc-def-01' }),
    ]);

    expect(tx.outbox.createMany).toHaveBeenCalledTimes(1);
    expect(tx.outbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          evento: 'os.criada',
          aggregateType: 'OrdemDeServico',
          aggregateId: 'os-1',
          payload: { numero: 'OS-1' },
          correlationId: 'corr-1',
          traceparent: null,
        },
        {
          evento: 'os.atualizada',
          aggregateType: 'OrdemDeServico',
          aggregateId: 'os-1',
          payload: { numero: 'OS-1' },
          correlationId: 'corr-1',
          traceparent: '00-abc-def-01',
        },
      ],
    });
  });

  it('propagates insert failures', async () => {
    const tx = makeTx();
    tx.outbox.createMany.mockRejectedValue(new Error('db down'));
    await expect(
      writer.append(tx as unknown as Prisma.TransactionClient, [event()]),
    ).rejects.toThrow('db down');
  });
});
