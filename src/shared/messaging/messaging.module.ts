import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';

import { MessageHandlerRegistry } from './handlers/message-handler.registry';
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
      // Os módulos de domínio registram seus handlers na criação (ver
      // ServiceOrdersModule), antes de o consumidor iniciar (os onModuleInit
      // rodam depois de todos os providers serem criados).
      useFactory: () => new MessageHandlerRegistry(),
    },
    OutboxPublisher,
    IdempotentProcessor,
    SqsConsumerService,
  ],
  exports: [MessageHandlerRegistry],
})
export class MessagingModule {}
