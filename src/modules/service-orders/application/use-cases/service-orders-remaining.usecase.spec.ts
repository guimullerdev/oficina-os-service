import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetOrdemDeServicoUseCase } from './get-service-orders.usecase';
import { AddServicoToOsUseCase } from './add-service-to-order.usecase';
import { AddPecaToOsUseCase } from './add-part-to-order.usecase';
import { RemoveServicoFromOsUseCase } from './remove-service-from-order.usecase';
import { RemovePecaFromOsUseCase } from './remove-part-from-order.usecase';
import { StartDiagnosisUseCase } from './start-diagnosis.usecase';
import { FinishDiagnosisUseCase } from './finish-diagnosis.usecase';
import { FinishOrderUseCase } from './finish-order.usecase';
import { DeliverOrderUseCase } from './deliver-order.usecase';
import { IniciarExecucaoUseCase } from './iniciar-execucao.usecase';
import { RealizarServicoUseCase } from './realizar-servico.usecase';
import { UtilizarPecaUseCase } from './utilizar-peca.usecase';
import { LiberarVeiculoUseCase } from './liberar-veiculo.usecase';
import { SendBudgetUseCase } from './send-budget.usecase';
import { RejectBudgetUseCase } from './reject-budget.usecase';
import { UpdateOrdemDeServicoUseCase } from './update-service-orders.usecase';
import { DeleteOrdemDeServicoUseCase } from './delete-service-orders.usecase';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import type { IOrdemDeServicoRepository } from '../../domain/repositories/service-orders.repository.interface';

const mockOsRepo = (): jest.Mocked<IOrdemDeServicoRepository> => ({
  findById: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  generateNumero: jest.fn(),
});

const makeOs = (
  status = StatusOS.RECEBIDA,
  extra: Partial<Parameters<typeof OrdemDeServico.restore>[0]> = {},
) =>
  OrdemDeServico.restore({
    id: 'os-1',
    numero: 'OS-001',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    status,
    servicos: [],
    pecas: [],
    historicoStatus: [],
    dataAbertura: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

// ─── GetOrdemDeServicoUseCase ────────────────────────────────────────────────
describe('GetOrdemDeServicoUseCase', () => {
  it('returns OS by id', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs());

    const useCase = new GetOrdemDeServicoUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.id).toBe('os-1');
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new GetOrdemDeServicoUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('executeAll returns list', async () => {
    const repo = mockOsRepo();
    repo.findAll.mockResolvedValue([makeOs()]);

    const useCase = new GetOrdemDeServicoUseCase(repo as any);
    const result = await useCase.executeAll();
    expect(result).toHaveLength(1);
  });
});

// ─── AddServicoToOsUseCase ───────────────────────────────────────────────────
describe('AddServicoToOsUseCase', () => {
  it('adds servico to OS with the given precoUnitario', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(makeOs());
    osRepo.update.mockImplementation(async (o) => o);

    const useCase = new AddServicoToOsUseCase(osRepo as any);
    const result = await useCase.execute('os-1', 's-1', 80);

    expect(osRepo.update).toHaveBeenCalledTimes(1);
    expect(result.servicos).toHaveLength(1);
    expect(result.servicos[0]).toMatchObject({
      servicoId: 's-1',
      precoUnitario: 80,
      status: 'pendente',
    });
    expect(typeof result.servicos[0].id).toBe('string');
  });

  it('throws NotFoundException if OS not found', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(null);

    const useCase = new AddServicoToOsUseCase(osRepo as any);
    await expect(useCase.execute('missing', 's-1', 80)).rejects.toThrow(
      NotFoundException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });

  it('throws ConflictException if servico already in OS', async () => {
    const osRepo = mockOsRepo();
    const os = makeOs(StatusOS.RECEBIDA, {
      servicos: [
        {
          id: 'item-1',
          servicoId: 's-1',
          precoUnitario: 80,
          status: 'pendente' as const,
        },
      ],
    });
    osRepo.findById.mockResolvedValue(os);

    const useCase = new AddServicoToOsUseCase(osRepo as any);
    await expect(useCase.execute('os-1', 's-1', 80)).rejects.toThrow(
      ConflictException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });
});

// ─── AddPecaToOsUseCase ──────────────────────────────────────────────────────
describe('AddPecaToOsUseCase', () => {
  it('adds peca to OS with the given precoUnitario', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(makeOs());
    osRepo.update.mockImplementation(async (o) => o);

    const useCase = new AddPecaToOsUseCase(osRepo as any);
    const result = await useCase.execute('os-1', 'p-1', 2, 25);

    expect(osRepo.update).toHaveBeenCalledTimes(1);
    expect(result.pecas).toHaveLength(1);
    expect(result.pecas[0]).toMatchObject({
      pecaId: 'p-1',
      quantidade: 2,
      valorUnitario: 25,
      status: 'reservada',
    });
  });

  it('throws NotFoundException if OS not found', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(null);

    const useCase = new AddPecaToOsUseCase(osRepo as any);
    await expect(useCase.execute('missing', 'p-1', 1, 25)).rejects.toThrow(
      NotFoundException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });

  it('throws ConflictException if peca already in OS', async () => {
    const osRepo = mockOsRepo();
    const os = makeOs(StatusOS.RECEBIDA, {
      pecas: [
        {
          id: 'item-1',
          pecaId: 'p-1',
          quantidade: 1,
          valorUnitario: 25,
          status: 'reservada' as const,
        },
      ],
    });
    osRepo.findById.mockResolvedValue(os);

    const useCase = new AddPecaToOsUseCase(osRepo as any);
    await expect(useCase.execute('os-1', 'p-1', 1, 25)).rejects.toThrow(
      ConflictException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });

  it('throws ConflictException if quantidade is invalid', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(makeOs());

    const useCase = new AddPecaToOsUseCase(osRepo as any);
    await expect(useCase.execute('os-1', 'p-1', 0, 25)).rejects.toThrow(
      ConflictException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });
});

// ─── RemoveServicoFromOsUseCase ──────────────────────────────────────────────
describe('RemoveServicoFromOsUseCase', () => {
  it('removes servico from OS', async () => {
    const osRepo = mockOsRepo();
    const os = makeOs(StatusOS.RECEBIDA, {
      servicos: [
        {
          id: 'item-1',
          servicoId: 's-1',
          precoUnitario: 80,
          status: 'pendente' as const,
        },
      ],
    });
    osRepo.findById.mockResolvedValue(os);
    osRepo.update.mockImplementation(async (o) => o);

    const useCase = new RemoveServicoFromOsUseCase(osRepo as any);
    const result = await useCase.execute('os-1', 's-1');

    expect(result.servicos).toHaveLength(0);
  });

  it('throws NotFoundException if OS not found', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(null);

    const useCase = new RemoveServicoFromOsUseCase(osRepo as any);
    await expect(useCase.execute('missing', 's-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException if servico not in OS', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(makeOs());

    const useCase = new RemoveServicoFromOsUseCase(osRepo as any);
    await expect(useCase.execute('os-1', 'not-there')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─── RemovePecaFromOsUseCase ─────────────────────────────────────────────────
describe('RemovePecaFromOsUseCase', () => {
  it('removes peca from OS', async () => {
    const osRepo = mockOsRepo();
    const os = makeOs(StatusOS.RECEBIDA, {
      pecas: [
        {
          id: 'item-1',
          pecaId: 'p-1',
          quantidade: 2,
          valorUnitario: 25,
          status: 'reservada' as const,
        },
      ],
    });
    osRepo.findById.mockResolvedValue(os);
    osRepo.update.mockImplementation(async (o) => o);

    const useCase = new RemovePecaFromOsUseCase(osRepo as any);
    const result = await useCase.execute('os-1', 'p-1');

    expect(osRepo.update).toHaveBeenCalledTimes(1);
    expect(result.pecas).toHaveLength(0);
  });

  it('throws NotFoundException if OS not found', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(null);

    const useCase = new RemovePecaFromOsUseCase(osRepo as any);
    await expect(useCase.execute('missing', 'p-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException if peca not in OS', async () => {
    const osRepo = mockOsRepo();
    osRepo.findById.mockResolvedValue(makeOs());

    const useCase = new RemovePecaFromOsUseCase(osRepo as any);
    await expect(useCase.execute('os-1', 'not-there')).rejects.toThrow(
      NotFoundException,
    );
    expect(osRepo.update).not.toHaveBeenCalled();
  });
});

// ─── StartDiagnosisUseCase ───────────────────────────────────────────────────
describe('StartDiagnosisUseCase', () => {
  it('transitions OS to EM_DIAGNOSTICO', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));
    repo.update.mockImplementation(async (o) => o);

    const useCase = new StartDiagnosisUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.status).toBe(StatusOS.EM_DIAGNOSTICO);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new StartDiagnosisUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.EM_EXECUCAO));

    const useCase = new StartDiagnosisUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('rethrows unexpected errors from iniciarDiagnostico', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.RECEBIDA);
    jest.spyOn(os, 'iniciarDiagnostico').mockImplementation(() => {
      throw new Error('unexpected');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new StartDiagnosisUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected');
  });
});

// ─── FinishDiagnosisUseCase ──────────────────────────────────────────────────
describe('FinishDiagnosisUseCase', () => {
  it('transitions OS to AGUARDANDO_APROVACAO and returns the persisted OS', async () => {
    const repo = mockOsRepo();
    const updated = makeOs(StatusOS.AGUARDANDO_APROVACAO);
    repo.findById.mockResolvedValue(makeOs(StatusOS.EM_DIAGNOSTICO));
    repo.update.mockResolvedValue(updated);

    const useCase = new FinishDiagnosisUseCase(
      repo as any,
      {
        registrarDiagnosticoConcluido: jest.fn(),
        obterCorrelationIdDaOs: jest.fn(),
      } as any,
    );
    const result = await useCase.execute('os-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(result).toBe(updated);
    expect(result.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new FinishDiagnosisUseCase(
      repo as any,
      { registrarDiagnosticoConcluido: jest.fn() } as any,
    );
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));

    const useCase = new FinishDiagnosisUseCase(
      repo as any,
      { registrarDiagnosticoConcluido: jest.fn() } as any,
    );
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors from concluirDiagnostico', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.EM_DIAGNOSTICO);
    jest.spyOn(os, 'concluirDiagnostico').mockImplementation(() => {
      throw new Error('unexpected-fd');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new FinishDiagnosisUseCase(
      repo as any,
      { registrarDiagnosticoConcluido: jest.fn() } as any,
    );
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected-fd');
  });
});

// ─── IniciarExecucaoUseCase ──────────────────────────────────────────────────
describe('IniciarExecucaoUseCase', () => {
  it('transitions OS to EM_EXECUCAO', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.APROVADA));
    repo.update.mockImplementation(async (o) => o);

    const useCase = new IniciarExecucaoUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.status).toBe(StatusOS.EM_EXECUCAO);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new IniciarExecucaoUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));

    const useCase = new IniciarExecucaoUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('rethrows unexpected errors from iniciarExecucao', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.APROVADA);
    jest.spyOn(os, 'iniciarExecucao').mockImplementation(() => {
      throw new Error('unexpected-ie');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new IniciarExecucaoUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected-ie');
  });
});

// ─── FinishOrderUseCase ──────────────────────────────────────────────────────
describe('FinishOrderUseCase', () => {
  it('transitions OS to FINALIZADA', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.EM_EXECUCAO));
    repo.update.mockImplementation(async (o) => o);

    const useCase = new FinishOrderUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.status).toBe(StatusOS.FINALIZADA);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new FinishOrderUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));

    const useCase = new FinishOrderUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('rethrows unexpected errors from finalizarExecucao', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.EM_EXECUCAO);
    jest.spyOn(os, 'finalizarExecucao').mockImplementation(() => {
      throw new Error('unexpected-fo');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new FinishOrderUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected-fo');
  });
});

// ─── DeliverOrderUseCase ─────────────────────────────────────────────────────
describe('DeliverOrderUseCase', () => {
  it('transitions OS to ENTREGUE', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.FINALIZADA));
    repo.update.mockImplementation(async (o) => o);

    const useCase = new DeliverOrderUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.status).toBe(StatusOS.ENTREGUE);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new DeliverOrderUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));

    const useCase = new DeliverOrderUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('rethrows unexpected errors from entregar', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.FINALIZADA);
    jest.spyOn(os, 'entregar').mockImplementation(() => {
      throw new Error('unexpected-do');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new DeliverOrderUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected-do');
  });
});

// ─── RealizarServicoUseCase ──────────────────────────────────────────────────
describe('RealizarServicoUseCase', () => {
  it('registers execution of a service item', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.EM_EXECUCAO, {
      servicos: [
        {
          id: 'item-s-1',
          servicoId: 's-1',
          precoUnitario: 80,
          status: 'pendente' as const,
        },
      ],
    });
    repo.findById.mockResolvedValue(os);
    repo.update.mockImplementation(async (o) => o);

    const inicio = new Date('2024-01-01T08:00:00');
    const fim = new Date('2024-01-01T10:00:00');
    const useCase = new RealizarServicoUseCase(repo as any);
    const result = await useCase.execute('os-1', 'item-s-1', inicio, fim);

    expect(result.servicos[0].inicioExec).toEqual(inicio);
    expect(result.servicos[0].fimExec).toEqual(fim);
  });

  it('throws NotFoundException if OS not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new RealizarServicoUseCase(repo as any);
    await expect(
      useCase.execute('missing', 'item-s-1', new Date(), new Date()),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─── UtilizarPecaUseCase ─────────────────────────────────────────────────────
describe('UtilizarPecaUseCase', () => {
  it('marks peca as used', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.EM_EXECUCAO, {
      pecas: [
        {
          id: 'item-p-1',
          pecaId: 'p-1',
          quantidade: 1,
          valorUnitario: 25,
          status: 'reservada' as const,
        },
      ],
    });
    repo.findById.mockResolvedValue(os);
    repo.update.mockImplementation(async (o) => o);

    const useCase = new UtilizarPecaUseCase(repo as any);
    const result = await useCase.execute('os-1', 'item-p-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(result.pecas[0].status).toBe('utilizada');
  });

  it('throws NotFoundException if OS not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new UtilizarPecaUseCase(repo as any);
    await expect(useCase.execute('missing', 'item-p-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException if peca item not found in OS', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs());

    const useCase = new UtilizarPecaUseCase(repo as any);
    await expect(useCase.execute('os-1', 'not-there')).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ─── LiberarVeiculoUseCase ───────────────────────────────────────────────────
describe('LiberarVeiculoUseCase', () => {
  it('returns the OS when found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.FINALIZADA));

    const useCase = new LiberarVeiculoUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.id).toBe('os-1');
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new LiberarVeiculoUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });
});

// ─── SendBudgetUseCase ───────────────────────────────────────────────────────
describe('SendBudgetUseCase', () => {
  it('returns the OS when found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));

    const useCase = new SendBudgetUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.id).toBe('os-1');
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new SendBudgetUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });
});

// ─── RejectBudgetUseCase ─────────────────────────────────────────────────────
describe('RejectBudgetUseCase', () => {
  it('transitions OS to REPROVADA', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));
    repo.update.mockImplementation(async (o) => o);

    const useCase = new RejectBudgetUseCase(repo as any);
    const result = await useCase.execute('os-1');
    expect(result.status).toBe(StatusOS.REPROVADA);
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new RejectBudgetUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });

  it('throws UnprocessableEntityException for invalid transition', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs(StatusOS.RECEBIDA));

    const useCase = new RejectBudgetUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('rethrows unexpected errors from reprovarOrcamento', async () => {
    const repo = mockOsRepo();
    const os = makeOs(StatusOS.AGUARDANDO_APROVACAO);
    jest.spyOn(os, 'reprovarOrcamento').mockImplementation(() => {
      throw new Error('unexpected-rb');
    });
    repo.findById.mockResolvedValue(os);

    const useCase = new RejectBudgetUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow('unexpected-rb');
  });
});

// ─── UpdateOrdemDeServicoUseCase ─────────────────────────────────────────────
describe('UpdateOrdemDeServicoUseCase', () => {
  it('updates descricaoProblema', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs());
    repo.update.mockImplementation(async (o) => o);

    const useCase = new UpdateOrdemDeServicoUseCase(repo as any);
    const result = await useCase.execute('os-1', {
      descricaoProblema: 'Barulho novo',
    });
    expect(result.descricaoProblema).toBe('Barulho novo');
  });

  it('throws NotFoundException if not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new UpdateOrdemDeServicoUseCase(repo as any);
    await expect(useCase.execute('missing', {})).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─── DeleteOrdemDeServicoUseCase ─────────────────────────────────────────────
describe('DeleteOrdemDeServicoUseCase', () => {
  it('throws Error because delete is not supported', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(makeOs());

    const useCase = new DeleteOrdemDeServicoUseCase(repo as any);
    await expect(useCase.execute('os-1')).rejects.toThrow(
      'Delete not supported for OS',
    );
  });

  it('throws NotFoundException if OS not found', async () => {
    const repo = mockOsRepo();
    repo.findById.mockResolvedValue(null);

    const useCase = new DeleteOrdemDeServicoUseCase(repo as any);
    await expect(useCase.execute('missing')).rejects.toThrow(NotFoundException);
  });
});
