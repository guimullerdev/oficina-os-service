import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { FinishDiagnosisUseCase } from './finish-diagnosis.usecase';
import { OrdemDeServico, StatusOS } from '../../domain/entities/service-orders.entity';
import { IOrdemDeServicoRepository } from '../../domain/repositories/service-orders.repository.interface';

const mockRepo = (): jest.Mocked<IOrdemDeServicoRepository> => ({
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    generateNumero: jest.fn(),
});

const mockSaga = () => ({ registrarDiagnosticoConcluido: jest.fn().mockResolvedValue(true) });

const makeDiagnosingOrder = () =>
    OrdemDeServico.create({ numero: 'OS-001', clienteId: 'c-1', veiculoId: 'v-1' }).iniciarDiagnostico();

describe('FinishDiagnosisUseCase', () => {
    it('throws 404 when order is not found', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        repo.findById.mockResolvedValue(null);
        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        await expect(useCase.execute('nonexistent')).rejects.toThrow(NotFoundException);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws 422 when status does not allow concluding diagnosis', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        repo.findById.mockResolvedValue(
            OrdemDeServico.create({ numero: 'OS-001', clienteId: 'c-1', veiculoId: 'v-1' }),
        );
        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        await expect(useCase.execute('order-1')).rejects.toThrow(UnprocessableEntityException);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('rethrows unexpected errors from concluirDiagnostico', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        const ordem = makeDiagnosingOrder();
        jest.spyOn(ordem, 'concluirDiagnostico').mockImplementation(() => { throw new Error('unexpected-fd'); });
        repo.findById.mockResolvedValue(ordem);
        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        await expect(useCase.execute('order-1')).rejects.toThrow('unexpected-fd');
    });

    it('updates the order and emits diagnostico.concluido with generated correlationId', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        const ordem = makeDiagnosingOrder();
        const concluida = ordem.concluirDiagnostico();
        repo.findById.mockResolvedValue(ordem);
        repo.update.mockResolvedValue(concluida);

        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        const result = await useCase.execute(ordem.id);

        expect(result.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
        const [updated, events] = repo.update.mock.calls[0];
        expect(updated.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
        expect(events).toEqual([{
            evento: 'diagnostico.concluido',
            aggregateType: 'ordem_de_servico',
            aggregateId: ordem.id,
            payload: { id: ordem.id, status: StatusOS.AGUARDANDO_APROVACAO },
            correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            traceparent: undefined,
        }]);
    });

    it('uses the correlationId and traceparent received in ctx', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        const ordem = makeDiagnosingOrder();
        repo.findById.mockResolvedValue(ordem);
        repo.update.mockImplementation(async (o: OrdemDeServico) => o);
        const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        await useCase.execute(ordem.id, { correlationId: 'corr-456', traceparent });

        const [, events] = repo.update.mock.calls[0];
        expect(events![0].correlationId).toBe('corr-456');
        expect(events![0].traceparent).toBe(traceparent);
    });

    it('registers the diagnosis in the saga inside the repository transaction hook', async () => {
        const repo = mockRepo();
        const saga = mockSaga();
        const ordem = makeDiagnosingOrder();
        repo.findById.mockResolvedValue(ordem);
        repo.update.mockImplementation(async (o: OrdemDeServico) => o);
        const useCase = new FinishDiagnosisUseCase(repo as any, saga as any);
        await useCase.execute(ordem.id);

        const naTransacao = repo.update.mock.calls[0][2]!;
        expect(saga.registrarDiagnosticoConcluido).not.toHaveBeenCalled();
        const tx = { marcador: 'tx' };
        await naTransacao(tx);
        expect(saga.registrarDiagnosticoConcluido).toHaveBeenCalledWith(ordem.id, tx);
    });
});
