import { Prisma, StatusPassoSaga, StatusSaga } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { SagaPrismaRepository } from './saga.repository';

const makeCliente = () => ({
  sagaInstancia: {
    create: jest.fn().mockResolvedValue({ id: 'saga-1', passos: [] }),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'saga-1' }),
  },
  sagaPasso: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
  },
});

const passo = (ordem: number) => ({
  ordem,
  nome: `passo-${ordem}`,
  status: StatusPassoSaga.PENDENTE,
  comando: 'CMD',
  eventoEsperado: 'EVT',
  expiraEm: null,
});

const criacao = {
  osId: 'os-1',
  tipo: 'ORDEM_DE_SERVICO',
  correlationId: 'corr-1',
  status: StatusSaga.EM_ANDAMENTO,
  passos: [passo(1), passo(2)],
};

describe('SagaPrismaRepository', () => {
  let prisma: ReturnType<typeof makeCliente>;
  let tx: ReturnType<typeof makeCliente>;
  let repo: SagaPrismaRepository;

  beforeEach(() => {
    prisma = makeCliente();
    tx = makeCliente();
    repo = new SagaPrismaRepository(prisma as unknown as PrismaService);
  });

  const txCliente = () => tx as unknown as Prisma.TransactionClient;

  describe('criar', () => {
    it('cria a saga com passos aninhados usando o client padrão', async () => {
      const result = await repo.criar(criacao);

      expect(prisma.sagaInstancia.create).toHaveBeenCalledWith({
        data: {
          osId: 'os-1',
          tipo: 'ORDEM_DE_SERVICO',
          correlationId: 'corr-1',
          status: StatusSaga.EM_ANDAMENTO,
          passos: { create: criacao.passos },
        },
        include: { passos: { orderBy: { ordem: 'asc' } } },
      });
      expect(result).toEqual({ id: 'saga-1', passos: [] });
    });

    it('repassa tentativas nos passos criados', async () => {
      const comTentativas = {
        ...criacao,
        passos: [{ ...passo(1), tentativas: 0 }],
      };

      await repo.criar(comTentativas);

      expect(prisma.sagaInstancia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            passos: { create: [expect.objectContaining({ tentativas: 0 })] },
          }),
        }),
      );
    });

    it('usa o tx quando informado', async () => {
      await repo.criar(criacao, txCliente());

      expect(tx.sagaInstancia.create).toHaveBeenCalledTimes(1);
      expect(prisma.sagaInstancia.create).not.toHaveBeenCalled();
    });
  });

  describe('buscarPorOs', () => {
    it('busca pela chave composta com tipo padrão ORDEM_DE_SERVICO', async () => {
      await repo.buscarPorOs('os-1');

      expect(prisma.sagaInstancia.findUnique).toHaveBeenCalledWith({
        where: { osId_tipo: { osId: 'os-1', tipo: 'ORDEM_DE_SERVICO' } },
        include: { passos: { orderBy: { ordem: 'asc' } } },
      });
    });

    it('respeita o tipo informado e usa o tx quando presente', async () => {
      tx.sagaInstancia.findUnique.mockResolvedValue({ id: 'saga-tx' });

      const result = await repo.buscarPorOs('os-1', 'OUTRO', txCliente());

      expect(tx.sagaInstancia.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { osId_tipo: { osId: 'os-1', tipo: 'OUTRO' } },
        }),
      );
      expect(prisma.sagaInstancia.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'saga-tx' });
    });

    it('devolve null quando a saga não existe', async () => {
      await expect(repo.buscarPorOs('os-inexistente')).resolves.toBeNull();
    });
  });

  describe('buscarPorCorrelationId', () => {
    it('busca pelo correlationId com passos ordenados', async () => {
      await repo.buscarPorCorrelationId('corr-1');

      expect(prisma.sagaInstancia.findFirst).toHaveBeenCalledWith({
        where: { correlationId: 'corr-1' },
        include: { passos: { orderBy: { ordem: 'asc' } } },
      });
    });

    it('usa o tx quando informado e devolve a saga encontrada', async () => {
      tx.sagaInstancia.findFirst.mockResolvedValue({
        id: 'saga-tx',
        passos: [],
      });

      const result = await repo.buscarPorCorrelationId('corr-1', txCliente());

      expect(tx.sagaInstancia.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.sagaInstancia.findFirst).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'saga-tx', passos: [] });
    });
  });

  describe('buscarPorId', () => {
    it('busca pela chave primária com passos ordenados', async () => {
      await repo.buscarPorId('saga-1');

      expect(prisma.sagaInstancia.findUnique).toHaveBeenCalledWith({
        where: { id: 'saga-1' },
        include: { passos: { orderBy: { ordem: 'asc' } } },
      });
    });

    it('usa o tx quando informado e devolve a saga encontrada', async () => {
      tx.sagaInstancia.findUnique.mockResolvedValue({
        id: 'saga-tx',
        passos: [],
      });

      const result = await repo.buscarPorId('saga-tx', txCliente());

      expect(tx.sagaInstancia.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.sagaInstancia.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'saga-tx', passos: [] });
    });

    it('devolve null quando a saga não existe', async () => {
      await expect(repo.buscarPorId('inexistente')).resolves.toBeNull();
    });
  });

  describe('atualizarPassoSeStatus', () => {
    it('retorna 1 quando o passo estava no status esperado', async () => {
      prisma.sagaPasso.updateMany.mockResolvedValue({ count: 1 });

      const count = await repo.atualizarPassoSeStatus(
        'passo-1',
        StatusPassoSaga.PENDENTE,
        {
          status: StatusPassoSaga.EM_ANDAMENTO,
        },
      );

      expect(count).toBe(1);
      expect(prisma.sagaPasso.updateMany).toHaveBeenCalledWith({
        where: { id: 'passo-1', status: StatusPassoSaga.PENDENTE },
        data: { status: StatusPassoSaga.EM_ANDAMENTO },
      });
    });

    it('retorna 0 quando o status atual já mudou (lock otimista)', async () => {
      prisma.sagaPasso.updateMany.mockResolvedValue({ count: 0 });

      const count = await repo.atualizarPassoSeStatus(
        'passo-1',
        StatusPassoSaga.PENDENTE,
        {
          status: StatusPassoSaga.EM_ANDAMENTO,
        },
      );

      expect(count).toBe(0);
    });

    it('incrementa tentativas, grava expiraEm e erro quando solicitado, usando o tx', async () => {
      const expiraEm = new Date('2026-01-01T00:00:00Z');
      tx.sagaPasso.updateMany.mockResolvedValue({ count: 1 });

      const count = await repo.atualizarPassoSeStatus(
        'passo-1',
        StatusPassoSaga.EM_ANDAMENTO,
        {
          status: StatusPassoSaga.FALHOU,
          expiraEm,
          erro: 'timeout',
          incrementarTentativas: true,
        },
        txCliente(),
      );

      expect(count).toBe(1);
      expect(prisma.sagaPasso.updateMany).not.toHaveBeenCalled();
      expect(tx.sagaPasso.updateMany).toHaveBeenCalledWith({
        where: { id: 'passo-1', status: StatusPassoSaga.EM_ANDAMENTO },
        data: {
          status: StatusPassoSaga.FALHOU,
          expiraEm,
          erro: 'timeout',
          tentativas: { increment: 1 },
        },
      });
    });

    it('não incrementa tentativas quando incrementarTentativas é falso', async () => {
      await repo.atualizarPassoSeStatus('passo-1', StatusPassoSaga.PENDENTE, {
        status: StatusPassoSaga.CONCLUIDO,
        incrementarTentativas: false,
      });

      const data = prisma.sagaPasso.updateMany.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('tentativas');
      expect(data.status).toBe(StatusPassoSaga.CONCLUIDO);
    });
  });

  describe('atualizarStatusSaga', () => {
    it('atualiza status e finalizadaEm com o client padrão', async () => {
      const finalizadaEm = new Date('2026-02-02T00:00:00Z');

      await repo.atualizarStatusSaga(
        'saga-1',
        StatusSaga.CONCLUIDA,
        finalizadaEm,
      );

      expect(prisma.sagaInstancia.update).toHaveBeenCalledWith({
        where: { id: 'saga-1' },
        data: { status: StatusSaga.CONCLUIDA, finalizadaEm },
      });
    });

    it('usa o tx quando informado e devolve a saga atualizada', async () => {
      tx.sagaInstancia.update.mockResolvedValue({ id: 'saga-tx' });

      const result = await repo.atualizarStatusSaga(
        'saga-1',
        StatusSaga.FALHOU,
        null,
        txCliente(),
      );

      expect(tx.sagaInstancia.update).toHaveBeenCalledWith({
        where: { id: 'saga-1' },
        data: { status: StatusSaga.FALHOU, finalizadaEm: null },
      });
      expect(prisma.sagaInstancia.update).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'saga-tx' });
    });
  });

  describe('criarPassos', () => {
    it('insere os passos vinculados à saga com o client padrão e devolve o count', async () => {
      const count = await repo.criarPassos('saga-1', [passo(1), passo(2)]);

      expect(count).toBe(2);
      expect(prisma.sagaPasso.createMany).toHaveBeenCalledWith({
        data: [
          { ...passo(1), sagaId: 'saga-1' },
          { ...passo(2), sagaId: 'saga-1' },
        ],
      });
    });

    it('usa o tx quando informado', async () => {
      tx.sagaPasso.createMany.mockResolvedValue({ count: 1 });

      const count = await repo.criarPassos('saga-1', [passo(3)], txCliente());

      expect(count).toBe(1);
      expect(tx.sagaPasso.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.sagaPasso.createMany).not.toHaveBeenCalled();
    });
  });
});
