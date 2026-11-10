import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';

import { MessageHandlerRegistry } from './handlers/message-handler.registry';
import { NOOP_HANDLERS } from './handlers/noop.handlers';
import { IdempotentProcessor } from './idempotency/idempotent-processor';
import { OutboxPublisher } from './outbox.publisher';
import { SqsConsumerService } from './sqs/sqs-consumer.service';

@Module({
  providers: [
    {
      provide: SNSClient,
      // O endpoint (LocalStack) vem de AWS_ENDPOINT_URL, lido pelo próprio SDK.
      useFactory: (config: ConfigService) =>
        new SNSClient({ region: config.get<string>('AWS_REGION') }),
      inject: [ConfigService],
    },
    {
      provide: SQSClient,
      // O endpoint (LocalStack) vem de AWS_ENDPOINT_URL, lido pelo próprio SDK.
      useFactory: (config: ConfigService) =>
        new SQSClient({ region: config.get<string>('AWS_REGION') }),
      inject: [ConfigService],
    },
    {
      provide: MessageHandlerRegistry,
      // Registra os handlers já na criação, antes de o consumidor iniciar
      // (os onModuleInit dos providers rodam depois de todos serem criados).
      useFactory: () => {
        const registry = new MessageHandlerRegistry();
        NOOP_HANDLERS.forEach((handler) => registry.register(handler));
        return registry;
      },
    },
    OutboxPublisher,
    IdempotentProcessor,
    SqsConsumerService,
  ],
})
export class MessagingModule {}
