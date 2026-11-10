import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';

import { PrismaService } from '../../prisma/prisma.service';
import { OutboxPublisher } from './outbox.publisher';

const TOPIC = 'arn:aws:sns:us-east-1:000000000000:oficina-os-events';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  evento: 'os.criada',
  payload: { numero: 'OS-1' },
  correlationId: 'corr-1',
  traceparent: '00-abc-def-01',
  ...over,
});

type UpdateArg = { where: { id: string }; data: Record<string, unknown> };

describe('OutboxPublisher', () => {
  const snsMock = mockClient(SNSClient);
  let tx: {
    $queryRaw: jest.Mock;
    outbox: { update: jest.Mock<Promise<unknown>, [UpdateArg]> };
  };
  let prisma: { $transaction: jest.Mock };
  let env: Record<string, string | undefined>;
  let publisher: OutboxPublisher;

  const updateArgs = (): UpdateArg[] =>
    tx.outbox.update.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    snsMock.reset();
    snsMock.on(PublishCommand).resolves({ MessageId: 'm-1' });

    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      outbox: {
        update: jest.fn<Promise<unknown>, [UpdateArg]>().mockResolvedValue({}),
      },
    };
    prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    env = {
      SNS_TOPIC_ARN: TOPIC,
      OUTBOX_PUBLISH_INTERVAL_MS: '1000',
      OUTBOX_BATCH_SIZE: '10',
      OUTBOX_PUBLISHER_ENABLED: 'true',
    };
    const config = { get: jest.fn((k: string) => env[k]) };

    publisher = new OutboxPublisher(
      prisma as unknown as PrismaService,
      new SNSClient({ region: 'us-east-1' }),
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    publisher.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('publishBatch', () => {
    it('does not call SNS for an empty batch', async () => {
      const result = await publisher.publishBatch();

      expect(result).toEqual({ published: 0, failed: 0 });
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
      expect(tx.outbox.update).not.toHaveBeenCalled();
    });

    it('selects pending rows with FOR UPDATE SKIP LOCKED and the batch size', async () => {
      await publisher.publishBatch();

      const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
        string[],
        ...unknown[],
      ];
      const sql = strings.join('?');
      expect(sql).toContain('published_at IS NULL');
      expect(sql).toContain('ORDER BY created_at');
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(values).toEqual([10]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('publishes message, attributes and eventId, then marks published_at', async () => {
      tx.$queryRaw.mockResolvedValue([row()]);

      const result = await publisher.publishBatch();

      expect(result).toEqual({ published: 1, failed: 0 });
      const calls = snsMock.commandCalls(PublishCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        TopicArn: TOPIC,
        Message: JSON.stringify({ numero: 'OS-1' }),
        MessageAttributes: {
          evento: { DataType: 'String', StringValue: 'os.criada' },
          eventId: { DataType: 'String', StringValue: 'row-1' },
          correlationId: { DataType: 'String', StringValue: 'corr-1' },
          traceparent: { DataType: 'String', StringValue: '00-abc-def-01' },
        },
      });
      expect(tx.outbox.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { publishedAt: expect.any(Date) as Date },
      });
    });

    it('omits correlationId and traceparent when absent', async () => {
      tx.$queryRaw.mockResolvedValue([
        row({ correlationId: '', traceparent: null }),
      ]);

      await publisher.publishBatch();

      const attrs =
        snsMock.commandCalls(PublishCommand)[0].args[0].input
          .MessageAttributes ?? {};
      expect(Object.keys(attrs).sort()).toEqual(['eventId', 'evento']);
    });

    it('records the failure and keeps going with the rest of the batch', async () => {
      tx.$queryRaw.mockResolvedValue([row({ id: 'bad' }), row({ id: 'good' })]);
      snsMock
        .on(PublishCommand)
        .rejectsOnce(new Error('sns unavailable'))
        .resolves({ MessageId: 'm-2' });

      const result = await publisher.publishBatch();

      expect(result).toEqual({ published: 1, failed: 1 });
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(2);
      expect(tx.outbox.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'bad' },
        data: {
          tentativas: { increment: 1 },
          ultimoErro: 'sns unavailable',
        },
      });
      expect(tx.outbox.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'good' },
        data: { publishedAt: expect.any(Date) as Date },
      });
    });

    it('stringifies non-Error rejections and truncates long messages', async () => {
      tx.$queryRaw.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
      snsMock
        .on(PublishCommand)
        .rejectsOnce('plain failure' as unknown as Error)
        .rejectsOnce(new Error('x'.repeat(5000)));

      const result = await publisher.publishBatch();

      expect(result.failed).toBe(2);
      const [first, second] = updateArgs();
      expect(first.data.ultimoErro).toBe('plain failure');
      expect(second.data.ultimoErro).toHaveLength(1000);
    });

    it('does not mark the row published when the publish fails', async () => {
      tx.$queryRaw.mockResolvedValue([row()]);
      snsMock.on(PublishCommand).rejects(new Error('boom'));

      await publisher.publishBatch();

      for (const arg of updateArgs()) {
        expect(arg.data).not.toHaveProperty('publishedAt');
      }
    });

    it('propagates database errors so the transaction rolls back', async () => {
      tx.$queryRaw.mockRejectedValue(new Error('db down'));

      await expect(publisher.publishBatch()).rejects.toThrow('db down');
    });

    it('propagates failures to record the error', async () => {
      tx.$queryRaw.mockResolvedValue([row()]);
      snsMock.on(PublishCommand).rejects(new Error('boom'));
      tx.outbox.update.mockRejectedValue(new Error('db down'));

      await expect(publisher.publishBatch()).rejects.toThrow('db down');
    });

    it('falls back to the default batch size for invalid config', async () => {
      env.OUTBOX_BATCH_SIZE = 'abc';

      await publisher.publishBatch();

      const [, ...values] = tx.$queryRaw.mock.calls[0] as unknown[];
      expect(values).toEqual([50]);
    });
  });

  describe('timer', () => {
    beforeEach(() => jest.useFakeTimers());

    it('does not start when the flag is not true', () => {
      env.OUTBOX_PUBLISHER_ENABLED = 'false';

      publisher.onModuleInit();
      jest.advanceTimersByTime(10_000);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not start when the flag is missing', () => {
      delete env.OUTBOX_PUBLISHER_ENABLED;

      publisher.onModuleInit();
      jest.advanceTimersByTime(10_000);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not start without a topic ARN', () => {
      delete env.SNS_TOPIC_ARN;

      publisher.onModuleInit();
      jest.advanceTimersByTime(10_000);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('publishes on every interval tick until destroyed', async () => {
      publisher.onModuleInit();

      await jest.advanceTimersByTimeAsync(1000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);

      publisher.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('uses the default interval for invalid config', async () => {
      env.OUTBOX_PUBLISH_INTERVAL_MS = '0';
      publisher.onModuleInit();

      await jest.advanceTimersByTimeAsync(4999);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('survives a failing batch and keeps ticking', async () => {
      prisma.$transaction
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce('not an error');
      publisher.onModuleInit();

      await jest.advanceTimersByTimeAsync(3000);

      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('skips a tick while the previous batch is still running', async () => {
      let release: (v: unknown) => void = () => undefined;
      prisma.$transaction.mockReturnValueOnce(
        new Promise((resolve) => (release = resolve)),
      );
      publisher.onModuleInit();

      await jest.advanceTimersByTimeAsync(3000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      release({ published: 0, failed: 0 });
      await jest.advanceTimersByTimeAsync(1000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('onModuleDestroy is a no-op when never started', () => {
      expect(() => publisher.onModuleDestroy()).not.toThrow();
    });
  });
});
