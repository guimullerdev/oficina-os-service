import { Injectable, NotFoundException } from '@nestjs/common';

import { SagaComPassos, SagaPrismaRepository } from './saga.repository';

@Injectable()
export class GetSagaUseCase {
  constructor(private readonly repo: SagaPrismaRepository) {}

  async execute(osId: string): Promise<SagaComPassos> {
    const saga = await this.repo.buscarPorOs(osId);
    if (!saga)
      throw new NotFoundException(
        `Saga da ordem de serviço ${osId} não encontrada`,
      );
    return saga;
  }
}
