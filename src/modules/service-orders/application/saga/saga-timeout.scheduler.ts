import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SagaOrchestrator } from './saga-orchestrator.service';

export const SAGA_TIMEOUT_INTERVAL_PADRAO_MS = 30_000;

const inteiroPositivo = (bruto: unknown, padrao: number): number => {
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 ? n : padrao;
};

// Dependências tipadas por contrato mínimo (type alias) e sem decorators de
// DI: o módulo instancia o scheduler via factory (ver service-orders.module),
// como faz com o SagaOrchestrator.
type OrquestradorTimeout = Pick<SagaOrchestrator, 'expirarVencidos'>;
type Configuracao = Pick<ConfigService, 'get'>;

/**
 * Dispara periodicamente a expiração dos passos de saga vencidos
 * (`SagaOrchestrator.expirarVencidos`). Ligado por `SAGA_TIMEOUT_ENABLED=true`;
 * intervalo em `SAGA_TIMEOUT_INTERVAL_MS` (default 30s).
 *
 * Seguro com várias réplicas rodando o scheduler: a seleção usa
 * `FOR UPDATE SKIP LOCKED`, então cada passo vencido é expirado por uma só.
 */
export class SagaTimeoutScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaTimeoutScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly orchestrator: OrquestradorTimeout,
    private readonly config: Configuracao,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('SAGA_TIMEOUT_ENABLED') !== 'true') {
      this.logger.log('Saga timeout scheduler disabled');
      return;
    }

    const intervalo = inteiroPositivo(
      this.config.get('SAGA_TIMEOUT_INTERVAL_MS'),
      SAGA_TIMEOUT_INTERVAL_PADRAO_MS,
    );
    this.timer = setInterval(() => void this.tick(), intervalo);
    this.timer.unref();
    this.logger.log(`Saga timeout scheduler started (every ${intervalo}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    // Evita sobreposição se uma execução demorar mais que o intervalo.
    if (this.running) return;
    this.running = true;
    try {
      const { expirados } = await this.orchestrator.expirarVencidos();
      if (expirados > 0) {
        this.logger.log(`Saga timeout: ${expirados} passo(s) expirado(s)`);
      }
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      this.logger.error(`Saga timeout failed: ${mensagem}`);
    } finally {
      this.running = false;
    }
  }
}
