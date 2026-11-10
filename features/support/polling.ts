export interface PollOptions {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const pollTimeoutMs = (): number =>
  envNumber('BDD_POLL_TIMEOUT_MS', 90000);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Repete `probe` até `isDone` aceitar o resultado ou o timeout estourar.
 * Erros do probe (ex.: app fora do ar) contam como "ainda não" e aparecem
 * na mensagem final junto com o último estado observado.
 */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? pollTimeoutMs();
  const intervalMs =
    options.intervalMs ?? envNumber('BDD_POLL_INTERVAL_MS', 500);
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;

  for (;;) {
    try {
      last = await probe();
      lastError = undefined;
      if (isDone(last)) return last;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }

  const state =
    lastError !== undefined
      ? `ultimo erro: ${lastError instanceof Error ? lastError.message : JSON.stringify(lastError)}`
      : `ultimo estado: ${JSON.stringify(last)}`;
  throw new Error(
    `Timeout apos ${timeoutMs}ms aguardando ${options.description}; ${state}`,
  );
}
