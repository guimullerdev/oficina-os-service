// O alias `src/` não é resolvido pelo Jest deste projeto; PrismaService só é token de DI.
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});

import { NotFoundException } from '@nestjs/common';

import { GetSagaUseCase } from './get-saga.usecase';

describe('GetSagaUseCase', () => {
  const saga = { id: 's-1', osId: 'os-1', passos: [] };
  let repo: { buscarPorOs: jest.Mock };
  let useCase: GetSagaUseCase;

  beforeEach(() => {
    repo = { buscarPorOs: jest.fn() };
    useCase = new GetSagaUseCase(repo as any);
  });

  it('retorna a saga da OS', async () => {
    repo.buscarPorOs.mockResolvedValue(saga);
    await expect(useCase.execute('os-1')).resolves.toBe(saga);
    expect(repo.buscarPorOs).toHaveBeenCalledWith('os-1');
  });

  it('lança NotFoundException quando a OS não tem saga', async () => {
    repo.buscarPorOs.mockResolvedValue(null);
    await expect(useCase.execute('os-1')).rejects.toThrow(NotFoundException);
  });
});
