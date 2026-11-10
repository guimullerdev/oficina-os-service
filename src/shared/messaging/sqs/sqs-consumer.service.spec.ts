import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';

import {
  IncomingMessage,
  MessageHandler,
} from '../handlers/message-handler.interface';
import { MessageHandlerRegistry } from '../handlers/message-handler.registry';
import { IdempotentProcessor } from '../idempotency/idempotent-processor';
import { SqsConsumerService } from './sqs-consumer.service';

const QUEUE_URL = 'http://localhost:4566/000000000000/oficina-os-queue';
const BACKOFF_MS = 2000;

const attr = (value: string) => ({ DataType: 'String', StringValue: value });

const message = (over: Partial<Message> = {}): Message => ({
  MessageId: 'm-1',
  ReceiptHandle: 'rh-1',
  Body: JSON.stringify({ numero: 'OS-1' }),
  MessageAttributes: {
    evento: attr('orcamento.gerado'),
    eventId: attr('evt-1'),
    correlationId: attr('corr-1'),
    traceparent: attr('00-abc-def-01'),
  },
  ...over,
});

describe('SqsConsumerService', () => {
  const sqsMock = mockClient(SQSClient);
  let env: Record<string, string | undefined>;
  let handler: MessageHandler;
  let processor: { process: jest.Mock };
  let errorLog: jest.SpyInstance;
  let consumer: SqsConsumerService;

  const deletes = () => sqsMock.commandCalls(DeleteMessageCommand);
  const receives = () => sqsMock.commandCalls(ReceiveMessageCommand);

  /** Responde aos receives em sequência; depois disso o long poll fica pendente até o abort. */
  const scriptReceives = (script: Array<Error | { Messages?: Message[] }>) => {
    let next = 0;
    // O reset descarta os `on(...)` do beforeEach, que teriam precedência sobre o callsFake.
    sqsMock.reset();
    sqsMock.send.callsFake(
      (command: unknown, options?: { abortSignal?: AbortSignal }) => {
        if (!(command instanceof ReceiveMessageCommand)) {
          return Promise.resolve({});
        }
        const step = script[next++];
        if (step instanceof Error) return Promise.reject(step);
        if (step) return Promise.resolve(step);
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      },
    );
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    sqsMock.reset();
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    sqsMock.on(DeleteMessageCommand).resolves({});

    env = {
      SQS_QUEUE_URL: QUEUE_URL,
      SQS_CONSUMER_ENABLED: 'true',
      SQS_WAIT_TIME_SECONDS: '20',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '30',
      SQS_MAX_MESSAGES: '10',
    };
    handler = { evento: 'orcamento.gerado', handle: jest.fn() };
    const registry = new MessageHandlerRegistry();
    registry.register(handler);
    processor = { process: jest.fn().mockResolvedValue('processed') };

    consumer = new SqsConsumerService(
      new SQSClient({ region: 'us-east-1' }),
      { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService,
      registry,
      processor as unknown as IdempotentProcessor,
    );
  });

  afterEach(async () => {
    await consumer.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('pollOnce', () => {
    it('envia o receive com os parâmetros configurados e atributos "All"', async () => {
      env.SQS_WAIT_TIME_SECONDS = '5';
      env.SQS_VISIBILITY_TIMEOUT_SECONDS = '45';
      env.SQS_MAX_MESSAGES = '7';

      await consumer.pollOnce();

      expect(receives()[0].args[0].input).toEqual({
        QueueUrl: QUEUE_URL,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 45,
        MaxNumberOfMessages: 7,
        MessageAttributeNames: ['All'],
      });
    });

    it('usa defaults para valores ausentes ou inválidos e limita o lote a 10', async () => {
      env.SQS_WAIT_TIME_SECONDS = undefined;
      env.SQS_VISIBILITY_TIMEOUT_SECONDS = 'abc';
      env.SQS_MAX_MESSAGES = '50';

      await consumer.pollOnce();

      expect(receives()[0].args[0].input).toMatchObject({
        WaitTimeSeconds: 20,
        VisibilityTimeout: 30,
        MaxNumberOfMessages: 10,
      });
    });

    it('repassa o AbortSignal ao SDK', async () => {
      const controller = new AbortController();
      let received: AbortSignal | undefined;
      sqsMock.reset();
      sqsMock.send.callsFake(
        (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
          received = options?.abortSignal;
          return Promise.resolve({});
        },
      );

      await consumer.pollOnce(controller.signal);

      expect(received).toBe(controller.signal);
    });

    it('retorna 0 quando o receive vem vazio', async () => {
      sqsMock.on(ReceiveMessageCommand).resolves({});

      await expect(consumer.pollOnce()).resolves.toBe(0);

      expect(processor.process).not.toHaveBeenCalled();
      expect(deletes()).toHaveLength(0);
    });

    it('processa e deleta a mensagem em caso de sucesso', async () => {
      sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message()] });

      await expect(consumer.pollOnce()).resolves.toBe(1);

      const expected: IncomingMessage = {
        messageId: 'm-1',
        evento: 'orcamento.gerado',
        eventId: 'evt-1',
        correlationId: 'corr-1',
        traceparent: '00-abc-def-01',
        payload: { numero: 'OS-1' },
      };
      expect(processor.process).toHaveBeenCalledWith(expected, handler);
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0].args[0].input).toEqual({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: 'rh-1',
      });
    });

    it('aceita atributos opcionais ausentes', async () => {
      sqsMock.on(ReceiveMessageCommand).resolves({
        Messages: [
          message({ MessageAttributes: { evento: attr('orcamento.gerado') } }),
        ],
      });

      await consumer.pollOnce();

      expect(processor.process).toHaveBeenCalledWith(
        {
          messageId: 'm-1',
          evento: 'orcamento.gerado',
          eventId: undefined,
          correlationId: undefined,
          traceparent: undefined,
          payload: { numero: 'OS-1' },
        },
        handler,
      );
      expect(deletes()).toHaveLength(1);
    });

    it('deleta a mensagem duplicada', async () => {
      processor.process.mockResolvedValue('duplicate');
      sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message()] });

      await consumer.pollOnce();

      expect(deletes()).toHaveLength(1);
    });

    it('não deleta JSON malformado e loga messageId e evento', async () => {
      sqsMock
        .on(ReceiveMessageCommand)
        .resolves({ Messages: [message({ Body: '{oops' })] });

      await consumer.pollOnce();

      expect(processor.process).not.toHaveBeenCalled();
      expect(deletes()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('messageId=m-1'),
      );
    });

    it('não deleta mensagem sem Body nem MessageId e loga "unknown"', async () => {
      sqsMock.on(ReceiveMessageCommand).resolves({
        Messages: [
          message({
            MessageId: undefined,
            Body: undefined,
            ReceiptHandle: 'r',
          }),
        ],
      });

      await consumer.pollOnce();

      expect(deletes()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('messageId=unknown'),
      );
    });

    it('não deleta mensagem sem o atributo evento', async () => {
      sqsMock
        .on(ReceiveMessageCommand)
        .resolves({ Messages: [message({ MessageAttributes: undefined })] });

      await consumer.pollOnce();

      expect(processor.process).not.toHaveBeenCalled();
      expect(deletes()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('evento=unknown'),
      );
    });

    it('não deleta evento desconhecido', async () => {
      sqsMock.on(ReceiveMessageCommand).resolves({
        Messages: [
          message({ MessageAttributes: { evento: attr('os.inexistente') } }),
        ],
      });

      await consumer.pollOnce();

      expect(processor.process).not.toHaveBeenCalled();
      expect(deletes()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('evento=os.inexistente'),
      );
    });

    it('não deleta quando o handler falha', async () => {
      processor.process.mockRejectedValue(new Error('boom'));
      sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message()] });

      await consumer.pollOnce();

      expect(deletes()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('evento=orcamento.gerado'),
      );
    });

    it('registra erro de valor não-Error lançado pelo handler', async () => {
      processor.process.mockRejectedValue('texto');
      sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message()] });

      await consumer.pollOnce();

      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('texto'));
    });

    it('um erro numa mensagem não impede as outras do lote', async () => {
      processor.process.mockRejectedValueOnce(new Error('boom'));
      sqsMock.on(ReceiveMessageCommand).resolves({
        Messages: [
          message({ MessageId: 'm-1', ReceiptHandle: 'rh-1' }),
          message({ MessageId: 'm-2', ReceiptHandle: 'rh-2' }),
        ],
      });

      await expect(consumer.pollOnce()).resolves.toBe(2);

      expect(processor.process).toHaveBeenCalledTimes(2);
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0].args[0].input.ReceiptHandle).toBe('rh-2');
    });

    it('loga e segue quando o delete falha', async () => {
      sqsMock.on(DeleteMessageCommand).rejects(new Error('delete failed'));
      sqsMock.on(ReceiveMessageCommand).resolves({
        Messages: [
          message({ MessageId: 'm-1' }),
          message({ MessageId: 'm-2' }),
        ],
      });

      await expect(consumer.pollOnce()).resolves.toBe(2);

      expect(processor.process).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete'),
      );
    });

    it('propaga a falha do receive', async () => {
      sqsMock.on(ReceiveMessageCommand).rejects(new Error('receive failed'));

      await expect(consumer.pollOnce()).rejects.toThrow('receive failed');
    });
  });

  describe('lifecycle', () => {
    it('não inicia com a flag desligada', async () => {
      env.SQS_CONSUMER_ENABLED = 'false';

      consumer.onModuleInit();
      await consumer.onModuleDestroy();

      expect(receives()).toHaveLength(0);
    });

    it('não inicia sem a flag', () => {
      env.SQS_CONSUMER_ENABLED = undefined;

      consumer.onModuleInit();

      expect(sqsMock.calls()).toHaveLength(0);
    });

    it('não inicia sem SQS_QUEUE_URL e registra erro', async () => {
      env.SQS_QUEUE_URL = undefined;

      expect(() => consumer.onModuleInit()).not.toThrow();
      await consumer.onModuleDestroy();

      expect(receives()).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('SQS_QUEUE_URL is not set'),
      );
    });

    it('faz polls em sequência e processa as mensagens recebidas', async () => {
      scriptReceives([
        { Messages: [message({ MessageId: 'm-1' })] },
        { Messages: [message({ MessageId: 'm-2', ReceiptHandle: 'rh-2' })] },
      ]);

      consumer.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      await consumer.onModuleDestroy();

      expect(processor.process).toHaveBeenCalledTimes(2);
      expect(deletes()).toHaveLength(2);
      expect(receives()).toHaveLength(3);
    });

    it('o destroy aborta o long poll em andamento e para o loop', async () => {
      scriptReceives([]);

      consumer.onModuleInit();
      await Promise.resolve();
      expect(receives()).toHaveLength(1);

      await consumer.onModuleDestroy();

      expect(receives()).toHaveLength(1);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('o destroy sem start é inofensivo', async () => {
      await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('espera o backoff após falha do receive e tenta de novo', async () => {
      jest.useFakeTimers();
      scriptReceives([new Error('receive failed'), { Messages: [message()] }]);

      consumer.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(receives()).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('SQS receive failed: receive failed'),
      );

      await jest.advanceTimersByTimeAsync(BACKOFF_MS - 1);
      expect(receives()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1);
      // 2º receive trouxe a mensagem; o 3º é o long poll pendente.
      expect(receives()).toHaveLength(3);
      expect(deletes()).toHaveLength(1);

      await consumer.onModuleDestroy();
    });

    it('o destroy interrompe o backoff', async () => {
      jest.useFakeTimers();
      scriptReceives([new Error('receive failed')]);

      consumer.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(receives()).toHaveLength(1);

      await consumer.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(BACKOFF_MS * 2);

      expect(receives()).toHaveLength(1);
    });
  });
});
