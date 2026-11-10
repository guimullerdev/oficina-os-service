import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SagaOrchestrator } from './saga-orchestrator.service';
import { SagaTimeoutScheduler } from './saga-timeout.scheduler';

describe('SagaTimeoutScheduler', () => {
  let orchestrator: { expirarVencidos: jest.Mock };
  let env: Record<string, string | undefined>;
  let scheduler: SagaTimeoutScheduler;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    orchestrator = {
      expirarVencidos: jest.fn().mockResolvedValue({ expirados: 0 }),
    };
    env = {
      SAGA_TIMEOUT_ENABLED: 'true',
      SAGA_TIMEOUT_INTERVAL_MS: '1000',
    };
    const config = { get: jest.fn((k: string) => env[k]) };

    scheduler = new SagaTimeoutScheduler(
      orchestrator as unknown as SagaOrchestrator,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('não inicia quando a flag não é true', () => {
      env.SAGA_TIMEOUT_ENABLED = 'false';

      scheduler.onModuleInit();
      jest.advanceTimersByTime(60_000);

      expect(orchestrator.expirarVencidos).not.toHaveBeenCalled();
    });

    it('não inicia quando a flag está ausente', () => {
      delete env.SAGA_TIMEOUT_ENABLED;

      scheduler.onModuleInit();
      jest.advanceTimersByTime(60_000);

      expect(orchestrator.expirarVencidos).not.toHaveBeenCalled();
    });

    it('expira os vencidos a cada intervalo até ser destruído', async () => {
      scheduler.onModuleInit();

      await jest.advanceTimersByTimeAsync(1000);
      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(3);

      scheduler.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);
      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(3);
    });

    it.each([['0'], ['-5'], ['1.5'], ['abc'], ['']])(
      'usa o intervalo padrão (30s) quando SAGA_TIMEOUT_INTERVAL_MS é %p',
      async (valor) => {
        env.SAGA_TIMEOUT_INTERVAL_MS = valor;
        scheduler.onModuleInit();

        await jest.advanceTimersByTimeAsync(29_999);
        expect(orchestrator.expirarVencidos).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(1);
      },
    );

    it('usa o intervalo padrão (30s) quando SAGA_TIMEOUT_INTERVAL_MS está ausente', async () => {
      delete env.SAGA_TIMEOUT_INTERVAL_MS;
      scheduler.onModuleInit();

      await jest.advanceTimersByTimeAsync(30_000);

      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(1);
    });

    it('não segura o processo vivo (timer com unref)', () => {
      const unref = jest.fn();
      jest.spyOn(global, 'setInterval').mockReturnValue({
        unref,
      } as unknown as NodeJS.Timeout);
      jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

      scheduler.onModuleInit();

      expect(unref).toHaveBeenCalledTimes(1);
    });
  });

  describe('tick', () => {
    beforeEach(() => scheduler.onModuleInit());

    it('registra quando expirou passos', async () => {
      orchestrator.expirarVencidos.mockResolvedValueOnce({ expirados: 2 });

      await jest.advanceTimersByTimeAsync(1000);

      expect(log).toHaveBeenCalledWith(expect.stringContaining('2'));
    });

    it('não registra nada quando não havia passo vencido', async () => {
      log.mockClear();

      await jest.advanceTimersByTimeAsync(1000);

      expect(log).not.toHaveBeenCalled();
    });

    it('captura e registra o erro e continua rodando', async () => {
      orchestrator.expirarVencidos
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce('não é um Error');

      await jest.advanceTimersByTimeAsync(3000);

      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('db down'),
      );
      expect(error).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('não é um Error'),
      );
    });

    it('não sobrepõe ticks enquanto a execução anterior não terminou', async () => {
      let liberar: (v: { expirados: number }) => void = () => undefined;
      orchestrator.expirarVencidos.mockReturnValueOnce(
        new Promise((resolve) => (liberar = resolve)),
      );

      await jest.advanceTimersByTimeAsync(3000);
      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(1);

      liberar({ expirados: 0 });
      await jest.advanceTimersByTimeAsync(1000);
      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(2);
    });

    it('libera a guarda após um erro (próximo tick executa)', async () => {
      orchestrator.expirarVencidos.mockRejectedValueOnce(new Error('boom'));

      await jest.advanceTimersByTimeAsync(2000);

      expect(orchestrator.expirarVencidos).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleDestroy', () => {
    it('é no-op quando nunca foi iniciado', () => {
      expect(() => scheduler.onModuleDestroy()).not.toThrow();
    });

    it('pode ser chamado duas vezes', () => {
      scheduler.onModuleInit();

      scheduler.onModuleDestroy();

      expect(() => scheduler.onModuleDestroy()).not.toThrow();
    });
  });
});
