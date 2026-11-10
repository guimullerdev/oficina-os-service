import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreateOrdemDeServicoUseCase } from './create-service-orders.usecase';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import { IOrdemDeServicoRepository } from '../../domain/repositories/service-orders.repository.interface';
import { IVeiculoRepository } from '../../../vehicles/domain/repositories/vehicle.repository.interface';
import { IClienteRepository } from '../../../customers/domain/repositories/customers.repository.interface';
import { Veiculo } from '../../../vehicles/domain/entities/vehicle.entity';
import { Cliente } from '../../../customers/domain/entities/customers.entity';
import { AddServicoToOsUseCase } from './add-service-to-order.usecase';
import { AddPecaToOsUseCase } from './add-part-to-order.usecase';

const mockOsRepo = (): jest.Mocked<IOrdemDeServicoRepository> => ({
  findAll: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  generateNumero: jest.fn(),
});

const mockVeiculoRepo = (): jest.Mocked<IVeiculoRepository> => ({
  findAll: jest.fn(),
  findById: jest.fn(),
  findByPlaca: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
});

const mockClienteRepo = (): jest.Mocked<IClienteRepository> => ({
  findAll: jest.fn(),
  findById: jest.fn(),
  findByDocumento: jest.fn(),
  findByNome: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
});

const mockAddServico = (): jest.Mocked<
  Pick<AddServicoToOsUseCase, 'execute'>
> => ({
  execute: jest.fn(),
});

const mockAddPeca = (): jest.Mocked<Pick<AddPecaToOsUseCase, 'execute'>> => ({
  execute: jest.fn(),
});

const makeVeiculo = (id: string, clienteId: string, ativo = true): Veiculo =>
  Veiculo.restore({
    id,
    placa: 'ABC1234',
    marca: 'Fiat',
    modelo: 'Uno',
    clienteId,
    ativo,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const makeCliente = (id: string, ativo = true): Cliente =>
  Cliente.restore({
    id,
    nome: 'Cliente Teste',
    documento: '52998224725',
    ativo,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

function makeUseCase(
  overrides: Partial<{
    repo: IOrdemDeServicoRepository;
    veiculoRepo: IVeiculoRepository;
    clienteRepo: IClienteRepository;
    addServico: any;
    addPeca: any;
    saga: any;
  }> = {},
) {
  const repo = overrides.repo ?? mockOsRepo();
  const veiculoRepo = overrides.veiculoRepo ?? mockVeiculoRepo();
  const clienteRepo = overrides.clienteRepo ?? mockClienteRepo();
  const addServico = overrides.addServico ?? mockAddServico();
  const addPeca = overrides.addPeca ?? mockAddPeca();
  const saga = overrides.saga ?? { iniciar: jest.fn() };
  return {
    repo,
    veiculoRepo,
    clienteRepo,
    addServico,
    addPeca,
    saga,
    useCase: new CreateOrdemDeServicoUseCase(
      repo as any,
      veiculoRepo as any,
      clienteRepo as any,
      addServico,
      addPeca,
      saga,
    ),
  };
}

describe('CreateOrdemDeServicoUseCase', () => {
  describe('happy path — no inline items', () => {
    it('creates a service order and returns it', async () => {
      const { repo, veiculoRepo, clienteRepo, useCase } = makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-001');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      const result = await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });

      expect((repo as any).create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(StatusOS.RECEBIDA);
      expect(result.numero).toBe('OS-001');
    });

    it('passes the correct entity to repo.create', async () => {
      const { repo, veiculoRepo, clienteRepo, useCase } = makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-002');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
        descricaoProblema: 'Problema',
      });

      const saved = (repo as any).create.mock.calls[0][0] as OrdemDeServico;
      expect(saved.clienteId).toBe('c-1');
      expect(saved.veiculoId).toBe('v-1');
      expect(saved.descricaoProblema).toBe('Problema');
    });
  });

  describe('inline servicos', () => {
    it('calls addServicoUseCase for each service in dto.servicos', async () => {
      const { repo, veiculoRepo, clienteRepo, addServico, useCase } =
        makeUseCase();
      const createdOs = OrdemDeServico.create({
        numero: 'OS-003',
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });
      const osWithSvc = createdOs.addServico({
        id: 'i-1',
        servicoId: 's-1',
        precoUnitario: 100,
        status: 'pendente',
      });

      (repo as any).generateNumero.mockResolvedValue('OS-003');
      (repo as any).create.mockResolvedValue(createdOs);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );
      addServico.execute.mockResolvedValue(osWithSvc);

      const result = await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
        servicos: [{ servicoId: 's-1', precoUnitario: 100 }],
      });

      expect(addServico.execute).toHaveBeenCalledTimes(1);
      expect(addServico.execute).toHaveBeenCalledWith(createdOs.id, 's-1', 100);
      expect(result.servicos).toHaveLength(1);
    });

    it('calls addServicoUseCase sequentially for multiple services', async () => {
      const { repo, veiculoRepo, clienteRepo, addServico, useCase } =
        makeUseCase();
      const baseOs = OrdemDeServico.create({
        numero: 'OS-004',
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });

      (repo as any).generateNumero.mockResolvedValue('OS-004');
      (repo as any).create.mockResolvedValue(baseOs);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );
      addServico.execute
        .mockResolvedValueOnce(
          baseOs.addServico({
            id: 'i-1',
            servicoId: 's-1',
            precoUnitario: 100,
            status: 'pendente',
          }),
        )
        .mockResolvedValueOnce(
          baseOs
            .addServico({
              id: 'i-1',
              servicoId: 's-1',
              precoUnitario: 100,
              status: 'pendente',
            })
            .addServico({
              id: 'i-2',
              servicoId: 's-2',
              precoUnitario: 200,
              status: 'pendente',
            }),
        );

      await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
        servicos: [
          { servicoId: 's-1', precoUnitario: 100 },
          { servicoId: 's-2', precoUnitario: 200 },
        ],
      });

      expect(addServico.execute).toHaveBeenCalledTimes(2);
      expect(addServico.execute).toHaveBeenNthCalledWith(
        1,
        baseOs.id,
        's-1',
        100,
      );
      expect(addServico.execute).toHaveBeenNthCalledWith(
        2,
        baseOs.id,
        's-2',
        200,
      );
    });

    it('does not call addServicoUseCase when servicos is absent', async () => {
      const { repo, veiculoRepo, clienteRepo, addServico, useCase } =
        makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-005');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      await useCase.execute({ clienteId: 'c-1', veiculoId: 'v-1' });

      expect(addServico.execute).not.toHaveBeenCalled();
    });
  });

  describe('inline pecas', () => {
    it('calls addPecaUseCase for each peca in dto.pecas', async () => {
      const { repo, veiculoRepo, clienteRepo, addPeca, useCase } =
        makeUseCase();
      const createdOs = OrdemDeServico.create({
        numero: 'OS-006',
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });
      const osWithPeca = createdOs.addPeca({
        id: 'ip-1',
        pecaId: 'p-1',
        quantidade: 2,
        valorUnitario: 50,
        status: 'reservada',
      });

      (repo as any).generateNumero.mockResolvedValue('OS-006');
      (repo as any).create.mockResolvedValue(createdOs);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );
      addPeca.execute.mockResolvedValue(osWithPeca);

      const result = await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
        pecas: [{ pecaId: 'p-1', quantidade: 2, precoUnitario: 50 }],
      });

      expect(addPeca.execute).toHaveBeenCalledTimes(1);
      expect(addPeca.execute).toHaveBeenCalledWith(createdOs.id, 'p-1', 2, 50);
      expect(result.pecas).toHaveLength(1);
    });

    it('does not call addPecaUseCase when pecas is absent', async () => {
      const { repo, veiculoRepo, clienteRepo, addPeca, useCase } =
        makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-007');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      await useCase.execute({ clienteId: 'c-1', veiculoId: 'v-1' });

      expect(addPeca.execute).not.toHaveBeenCalled();
    });
  });

  describe('domain event os.criada', () => {
    it('passes an os.criada event with aggregate, payload and generated correlationId', async () => {
      const { repo, veiculoRepo, clienteRepo, useCase } = makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-008');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      const result = await useCase.execute({
        clienteId: 'c-1',
        veiculoId: 'v-1',
      });

      const [, events] = (repo as any).create.mock.calls[0];
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        evento: 'os.criada',
        aggregateType: 'ordem_de_servico',
        aggregateId: result.id,
        payload: {
          id: result.id,
          numero: 'OS-008',
          clienteId: 'c-1',
          veiculoId: 'v-1',
          status: StatusOS.RECEBIDA,
        },
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        traceparent: undefined,
      });
    });

    it('uses the correlationId and traceparent received in ctx', async () => {
      const { repo, veiculoRepo, clienteRepo, useCase } = makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-009');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );
      const traceparent =
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

      await useCase.execute(
        { clienteId: 'c-1', veiculoId: 'v-1' },
        { correlationId: 'corr-123', traceparent },
      );

      const [, events] = (repo as any).create.mock.calls[0];
      expect(events[0].correlationId).toBe('corr-123');
      expect(events[0].traceparent).toBe(traceparent);
    });

    it('starts the saga inside the repository transaction hook with the os.criada correlationId', async () => {
      const { repo, veiculoRepo, clienteRepo, saga, useCase } = makeUseCase();
      (repo as any).generateNumero.mockResolvedValue('OS-010');
      (repo as any).create.mockImplementation(async (o: OrdemDeServico) => o);
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1'),
      );

      const os = await useCase.execute(
        { clienteId: 'c-1', veiculoId: 'v-1' },
        { correlationId: 'corr-777' },
      );

      const naTransacao = (repo as any).create.mock.calls[0][2];
      expect(saga.iniciar).not.toHaveBeenCalled();
      const tx = { marcador: 'tx' };
      await naTransacao(tx);
      expect(saga.iniciar).toHaveBeenCalledWith(os.id, 'corr-777', tx);
    });
  });

  describe('validation errors', () => {
    it('throws NotFoundException when customer does not exist', async () => {
      const { clienteRepo, useCase } = makeUseCase();
      (clienteRepo as any).findById.mockResolvedValue(null);

      await expect(
        useCase.execute({ clienteId: 'c-inexistente', veiculoId: 'v-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when customer is inactive', async () => {
      const { clienteRepo, useCase } = makeUseCase();
      (clienteRepo as any).findById.mockResolvedValue(
        makeCliente('c-1', false),
      );

      await expect(
        useCase.execute({ clienteId: 'c-1', veiculoId: 'v-1' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws NotFoundException when vehicle does not exist', async () => {
      const { clienteRepo, veiculoRepo, useCase } = makeUseCase();
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(null);

      await expect(
        useCase.execute({ clienteId: 'c-1', veiculoId: 'v-inexistente' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when vehicle is inactive', async () => {
      const { clienteRepo, veiculoRepo, useCase } = makeUseCase();
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-1', false),
      );

      await expect(
        useCase.execute({ clienteId: 'c-1', veiculoId: 'v-1' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws BadRequestException when vehicle belongs to a different customer', async () => {
      const { clienteRepo, veiculoRepo, useCase } = makeUseCase();
      (clienteRepo as any).findById.mockResolvedValue(makeCliente('c-1'));
      (veiculoRepo as any).findById.mockResolvedValue(
        makeVeiculo('v-1', 'c-outro'),
      );

      await expect(
        useCase.execute({ clienteId: 'c-1', veiculoId: 'v-1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
