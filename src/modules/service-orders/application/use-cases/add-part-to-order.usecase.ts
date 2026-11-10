import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ORDEM_DE_SERVICO_REPOSITORY,
  IOrdemDeServicoRepository,
} from '../../domain/repositories/service-orders.repository.interface';
import { OrdemDeServico } from '../../domain/entities/service-orders.entity';

@Injectable()
export class AddPecaToOsUseCase {
  constructor(
    @Inject(ORDEM_DE_SERVICO_REPOSITORY)
    private readonly osRepo: IOrdemDeServicoRepository,
  ) {}

  async execute(
    osId: string,
    pecaId: string,
    quantidade: number,
    precoUnitario: number,
  ): Promise<OrdemDeServico> {
    const os = await this.osRepo.findById(osId);
    if (!os)
      throw new NotFoundException(`Ordem de serviço ${osId} não encontrada`);

    let updated: OrdemDeServico;
    try {
      updated = os.addPeca({
        id: crypto.randomUUID(),
        pecaId,
        quantidade,
        valorUnitario: precoUnitario,
        status: 'reservada',
      });
    } catch (err: any) {
      throw new ConflictException(err.message);
    }

    return this.osRepo.update(updated);
  }
}
