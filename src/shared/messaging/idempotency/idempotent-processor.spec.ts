import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  IncomingMessage,
  MessageHandler,
} from '../handlers/message-handler.interface';
import { IdempotentProcessor } from './idempotent-processor';

const message = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  messageId: 'msg-1',
  evento: 'os.criada',
  payload: { numero: 'OS-1' },
  ...over,
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
  });

/**
 * Simula `$transaction` interativa: o insert só é "confirmado" se o callback
 * resolver; se rejeitar, o insert é desfeito (rollback).
 */
const makeHarness = () => {
  const committed = new Set<string>();
  const pending = new Set<string>();

  const create = jest.fn(({ data }: { data: { eventId: string } }) => {
    if (committed.has(data.eventId)) {
      return Promise.reject(prismaError('P2002'));
    }
    pending.add(data.eventId);
    return Promise.resolve(data);
  });
  const tx = { mensagemProcessada: { create } };

  const $transaction = jest.fn(async (fn: (t: typeof tx) => Promise<void>) => {
    pending.clear();
    try {
      await fn(tx);
      pending.forEach((id) => committed.add(id));
    } finally {
      pending.clear();
    }
  });

  const prisma = { $transaction } as unknown as PrismaService;
  return { prisma, $transaction, create, committed, tx };
};

const makeHandler = () => {
  const handle = jest.fn().mockResolvedValue(undefined);
  const handler: MessageHandler = { evento: 'os.criada', handle };
  return { handler, handle };
};

describe('IdempotentProcessor', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('processes a new message: inserts the event id and runs the handler in one transaction', async () => {
    const { prisma, $transaction, create } = makeHarness();
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);
    const msg = message({ eventId: 'evt-1' });

    await expect(processor.process(msg, handler)).resolves.toBe('processed');

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { eventId: 'evt-1', evento: 'os.criada' },
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(msg, expect.anything());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not run the handler again on a second delivery of the same eventId', async () => {
    const { prisma } = makeHarness();
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    const first = await processor.process(
      message({ messageId: 'msg-1', eventId: 'evt-1' }),
      handler,
    );
    const second = await processor.process(
      message({ messageId: 'msg-2', eventId: 'evt-1' }),
      handler,
    );

    expect(first).toBe('processed');
    expect(second).toBe('duplicate');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('evt-1'));
  });

  it('falls back to messageId when eventId is absent', async () => {
    const { prisma, create } = makeHarness();
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    await expect(
      processor.process(message({ messageId: 'msg-9' }), handler),
    ).resolves.toBe('processed');
    expect(create).toHaveBeenCalledWith({
      data: { eventId: 'msg-9', evento: 'os.criada' },
    });

    await expect(
      processor.process(message({ messageId: 'msg-9' }), handler),
    ).resolves.toBe('duplicate');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('rolls back the insert and rethrows when the handler fails, so a retry reprocesses', async () => {
    const { prisma, committed } = makeHarness();
    const { handler, handle } = makeHandler();
    handle.mockRejectedValueOnce(new Error('handler down'));
    const processor = new IdempotentProcessor(prisma);
    const msg = message({ eventId: 'evt-1' });

    await expect(processor.process(msg, handler)).rejects.toThrow(
      'handler down',
    );
    expect(committed.has('evt-1')).toBe(false);

    await expect(processor.process(msg, handler)).resolves.toBe('processed');
    expect(handle).toHaveBeenCalledTimes(2);
    expect(committed.has('evt-1')).toBe(true);
  });

  it('returns duplicate on P2002 without calling the handler or throwing', async () => {
    const { prisma, create } = makeHarness();
    create.mockRejectedValueOnce(prismaError('P2002'));
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    await expect(
      processor.process(message({ eventId: 'evt-1' }), handler),
    ).resolves.toBe('duplicate');
    expect(handle).not.toHaveBeenCalled();
  });

  it('rethrows other Prisma errors', async () => {
    const { prisma, create } = makeHarness();
    create.mockRejectedValueOnce(prismaError('P2003'));
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    await expect(
      processor.process(message({ eventId: 'evt-1' }), handler),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(handle).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rethrows non-Prisma errors', async () => {
    const { prisma, create } = makeHarness();
    create.mockRejectedValueOnce(new Error('connection lost'));
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    await expect(
      processor.process(message({ eventId: 'evt-1' }), handler),
    ).rejects.toThrow('connection lost');
    expect(handle).not.toHaveBeenCalled();
  });

  it('passes the transaction client to the handler', async () => {
    const { prisma, tx } = makeHarness();
    const { handler, handle } = makeHandler();
    const processor = new IdempotentProcessor(prisma);

    await processor.process(message(), handler);

    expect(handle).toHaveBeenCalledWith(expect.anything(), tx);
  });
});
