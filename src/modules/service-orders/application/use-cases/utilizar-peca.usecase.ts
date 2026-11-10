import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ORDEM_DE_SERVICO_REPOSITORY,
  IOrdemDeServicoRepository,
} from '../../domain/repositories/service-orders.repository.interface';
import { OrdemDeServico } from '../../domain/entities/service-orders.entity';

@Injectable()
export class UtilizarPecaUseCase {
  constructor(
    @Inject(ORDEM_DE_SERVICO_REPOSITORY)
    private readonly repo: IOrdemDeServicoRepository,
  ) {}

  async execute(osId: string, itemId: string): Promise<OrdemDeServico> {
    const os = await this.repo.findById(osId);
    if (!os)
      throw new NotFoundException(`Ordem de serviço ${osId} não encontrada`);

    const item = os.pecas.find((p) => p.id === itemId);
    if (!item)
      throw new NotFoundException(
        `Item de peça ${itemId} não encontrado na OS`,
      );

    return this.repo.update(os.marcarPecaUtilizada(itemId));
  }
}
