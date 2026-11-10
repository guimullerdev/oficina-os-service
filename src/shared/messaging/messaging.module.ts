import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient } from '@aws-sdk/client-sns';

import { OutboxPublisher } from './outbox.publisher';

@Module({
  providers: [
    {
      provide: SNSClient,
      // O endpoint (LocalStack) vem de AWS_ENDPOINT_URL, lido pelo próprio SDK.
      useFactory: (config: ConfigService) =>
        new SNSClient({ region: config.get<string>('AWS_REGION') }),
      inject: [ConfigService],
    },
    OutboxPublisher,
  ],
})
export class MessagingModule {}
