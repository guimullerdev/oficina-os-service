import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RegisterUseCase } from './register.usecase';
import { UserRole } from '../../domain/enums/user-role.enum';
import { User } from '../../domain/entities/user.entity';
import type { UserRepository } from '../../domain/repositories/user.repository.interface';

const mockRepo = (): jest.Mocked<UserRepository> => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  updateRefreshToken: jest.fn(),
});

const mockJwt = () => ({
  signAsync: jest.fn().mockResolvedValue('token'),
});

const mockConfig = () => ({
  get: jest.fn(),
});

describe('RegisterUseCase', () => {
  it('creates a user and returns tokens', async () => {
    const repo = mockRepo();
    const jwt = mockJwt();
    const config = mockConfig();
    repo.findByEmail.mockResolvedValue(null);
    const user = User.restore({
      id: 'u-1',
      email: 'a@b.com',
      passwordHash: 'hash',
      refreshTokenHash: null,
      createdAt: new Date(),
    });
    repo.create.mockResolvedValue(user);
    repo.updateRefreshToken.mockResolvedValue();

    const useCase = new RegisterUseCase(repo as any, jwt as any, config as any);
    const result = await useCase.execute({
      email: 'a@b.com',
      password: 'pass123',
    });

    expect(repo.findByEmail).toHaveBeenCalledWith('a@b.com');
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
  });

  it('throws ConflictException if email already exists', async () => {
    const repo = mockRepo();
    const jwt = mockJwt();
    const config = mockConfig();
    const user = User.restore({
      id: 'u-1',
      email: 'a@b.com',
      passwordHash: 'hash',
      refreshTokenHash: null,
      createdAt: new Date(),
    });
    repo.findByEmail.mockResolvedValue(user);

    const useCase = new RegisterUseCase(repo as any, jwt as any, config as any);
    await expect(
      useCase.execute({ email: 'a@b.com', password: 'pass123' }),
    ).rejects.toThrow(ConflictException);
  });

  describe('role handling', () => {
    const setup = () => {
      const repo = mockRepo();
      repo.findByEmail.mockResolvedValue(null);
      repo.create.mockImplementation((u) =>
        Promise.resolve(
          User.restore({
            id: 'u-1',
            email: u.email,
            passwordHash: 'hash',
            refreshTokenHash: null,
            role: u.role,
            createdAt: new Date(),
          } as any),
        ),
      );
      repo.updateRefreshToken.mockResolvedValue();
      const useCase = new RegisterUseCase(
        repo as any,
        mockJwt() as any,
        mockConfig() as any,
      );
      return { repo, useCase };
    };
    const base = { email: 'a@b.com', password: 'pass123' };

    it('defaults to ATENDENTE without role and without requester', async () => {
      const { repo, useCase } = setup();
      await useCase.execute(base);
      expect(repo.create.mock.calls[0][0].role).toBe(UserRole.ATENDENTE);
    });

    it('honors role when requester is ADMIN', async () => {
      const { repo, useCase } = setup();
      await useCase.execute(
        { ...base, role: UserRole.MECANICO },
        { role: UserRole.ADMIN },
      );
      expect(repo.create.mock.calls[0][0].role).toBe(UserRole.MECANICO);
    });

    it('throws Forbidden when role is set and requester is not ADMIN', async () => {
      const { repo, useCase } = setup();
      await expect(
        useCase.execute(
          { ...base, role: UserRole.ADMIN },
          { role: UserRole.ATENDENTE },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('throws Forbidden when role is set and there is no requester', async () => {
      const { repo, useCase } = setup();
      await expect(
        useCase.execute({ ...base, role: UserRole.ADMIN }),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
