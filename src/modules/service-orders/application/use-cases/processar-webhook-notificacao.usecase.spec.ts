import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ProcessarWebhookNotificacaoUseCase } from './processar-webhook-notificacao.usecase';
import { WebhookAcao } from '../dto/webhook-notificacao.dto';
import {
  OrdemDeServico,
  StatusOS,
} from '../../domain/entities/service-orders.entity';
import { IOrdemDeServicoRepository } from '../../domain/repositories/service-orders.repository.interface';

const makeOs = (status: StatusOS): OrdemDeServico =>
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
  });

const mockOsRepo = (): jest.Mocked<IOrdemDeServicoRepository> => ({
  findAll: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  generateNumero: jest.fn(),
});

function makeUseCase() {
  const osRepo = mockOsRepo();
  osRepo.update.mockImplementation(async (o) => o);
  const metrics = { registrarTransicao: jest.fn() };
  const useCase = new ProcessarWebhookNotificacaoUseCase(
    osRepo as any,
    metrics as any,
  );
  return { osRepo, metrics, useCase };
}

describe('ProcessarWebhookNotificacaoUseCase', () => {
  describe('OS não encontrada', () => {
    it('throws NotFoundException sem persistir nem emitir métrica', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(null);

      await expect(
        useCase.execute(
          { osId: 'os-x', acao: WebhookAcao.APROVAR },
          '127.0.0.1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(osRepo.update).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  describe('APROVAR — OS em AGUARDANDO_APROVACAO', () => {
    it('aprova a OS, emite métrica e retorna APLICADA', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));

      const result = await useCase.execute(
        { osId: 'os-1', acao: WebhookAcao.APROVAR },
        '10.0.0.1',
      );

      expect(osRepo.update).toHaveBeenCalledTimes(1);
      const salva = await osRepo.update.mock.results[0].value;
      expect(salva.status).toBe(StatusOS.APROVADA);
      expect(metrics.registrarTransicao).toHaveBeenCalledWith(salva);
      expect(result).toEqual({
        resultado: 'APLICADA',
        osId: 'os-1',
        statusAtual: StatusOS.APROVADA,
        mensagem: 'Orçamento aprovado com sucesso.',
      });
    });

    it('registra observacoes no log de auditoria', async () => {
      const { osRepo, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));
      const logSpy = jest
        .spyOn((useCase as any).logger, 'log')
        .mockImplementation(() => undefined);

      await useCase.execute(
        { osId: 'os-1', acao: WebhookAcao.APROVAR, observacoes: 'ok' },
        '10.0.0.1',
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"observacoes":"ok"'),
      );
    });
  });

  describe('REPROVAR — OS em AGUARDANDO_APROVACAO', () => {
    it('reprova a OS, emite métrica e retorna APLICADA', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));

      const result = await useCase.execute(
        {
          osId: 'os-1',
          acao: WebhookAcao.REPROVAR,
          observacoes: 'Fora do orçamento',
        },
        '10.0.0.2',
      );

      expect(osRepo.update).toHaveBeenCalledTimes(1);
      const salva = await osRepo.update.mock.results[0].value;
      expect(salva.status).toBe(StatusOS.REPROVADA);
      expect(metrics.registrarTransicao).toHaveBeenCalledWith(salva);
      expect(result).toEqual({
        resultado: 'APLICADA',
        osId: 'os-1',
        statusAtual: StatusOS.REPROVADA,
        mensagem: 'Orçamento reprovado com sucesso.',
      });
    });
  });

  describe('Persistência com falha', () => {
    it('propaga o erro e não emite métrica', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.AGUARDANDO_APROVACAO));
      osRepo.update.mockRejectedValue(new Error('db down'));

      await expect(
        useCase.execute({ osId: 'os-1', acao: WebhookAcao.APROVAR }, '1.2.3.4'),
      ).rejects.toThrow('db down');
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });
  });

  describe('Idempotência', () => {
    it('retorna IGNORADA_IDEMPOTENTE quando APROVAR e OS já está APROVADA', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.APROVADA));

      const result = await useCase.execute(
        { osId: 'os-1', acao: WebhookAcao.APROVAR },
        '1.2.3.4',
      );

      expect(osRepo.update).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(result.resultado).toBe('IGNORADA_IDEMPOTENTE');
      expect(result.statusAtual).toBe(StatusOS.APROVADA);
    });

    it('retorna IGNORADA_IDEMPOTENTE quando REPROVAR e OS já está REPROVADA', async () => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.REPROVADA));

      const result = await useCase.execute(
        { osId: 'os-1', acao: WebhookAcao.REPROVAR },
        '1.2.3.4',
      );

      expect(osRepo.update).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
      expect(result.resultado).toBe('IGNORADA_IDEMPOTENTE');
      expect(result.statusAtual).toBe(StatusOS.REPROVADA);
    });
  });

  describe('Rejeição por status inválido', () => {
    const invalidStatuses = [
      StatusOS.RECEBIDA,
      StatusOS.EM_DIAGNOSTICO,
      StatusOS.EM_EXECUCAO,
      StatusOS.FINALIZADA,
      StatusOS.ENTREGUE,
    ];

    it.each(invalidStatuses)('lança 422 quando status é %s', async (status) => {
      const { osRepo, metrics, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(status));

      await expect(
        useCase.execute({ osId: 'os-1', acao: WebhookAcao.APROVAR }, '1.2.3.4'),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(osRepo.update).not.toHaveBeenCalled();
      expect(metrics.registrarTransicao).not.toHaveBeenCalled();
    });

    it('lança 422 quando APROVAR e OS está REPROVADA (ação conflitante)', async () => {
      const { osRepo, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.REPROVADA));

      await expect(
        useCase.execute({ osId: 'os-1', acao: WebhookAcao.APROVAR }, '1.2.3.4'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('lança 422 quando REPROVAR e OS está APROVADA (ação conflitante)', async () => {
      const { osRepo, useCase } = makeUseCase();
      osRepo.findById.mockResolvedValue(makeOs(StatusOS.APROVADA));

      await expect(
        useCase.execute(
          { osId: 'os-1', acao: WebhookAcao.REPROVAR },
          '1.2.3.4',
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });
});
