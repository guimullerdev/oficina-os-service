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
export class AddServicoToOsUseCase {
  constructor(
    @Inject(ORDEM_DE_SERVICO_REPOSITORY)
    private readonly osRepo: IOrdemDeServicoRepository,
  ) {}

  async execute(
    osId: string,
    servicoId: string,
    precoUnitario: number,
  ): Promise<OrdemDeServico> {
    const os = await this.osRepo.findById(osId);
    if (!os)
      throw new NotFoundException(`Ordem de serviço ${osId} não encontrada`);

    let updated: OrdemDeServico;
    try {
      updated = os.addServico({
        id: crypto.randomUUID(),
        servicoId,
        precoUnitario,
        status: 'pendente',
      });
    } catch (err) {
      throw new ConflictException(
        err instanceof Error ? err.message : String(err),
      );
    }

    return this.osRepo.update(updated);
  }
}
