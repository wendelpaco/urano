/**
 * Retry Utility — Backoff exponencial com jitter, tratamento de 429,
 * e distinção entre erros de rate limit e erros de servidor.
 *
 * Comportamento por status HTTP:
 *  - 429 Too Many Requests:   usa Retry-After header, backoff mais longo
 *  - 5xx (500, 502, 503):     backoff normal, recomeça
 *  - 4xx (exceto 429):        NÃO retenta (erro do cliente)
 *  - Erros de rede (fetch):   backoff normal
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  /** Número máximo de tentativas (padrão: 3) */
  maxRetries: number;
  /** Delay inicial em ms (padrão: 1000) */
  initialDelay: number;
  /** Delay máximo em ms (padrão: 30000) */
  maxDelay: number;
  /** Fator de backoff exponencial (padrão: 2) */
  backoffFactor: number;
  /** Timeout por tentativa em ms (opcional) */
  timeout?: number;
  /** Callback chamado a cada retry */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const defaultOptions: RetryOptions = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30_000,
  backoffFactor: 2,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Calcula delay com jitter: delay base ± até 30% aleatório.
 * Jitter evita thundering herd quando múltiplas requisições
 * são retentadas simultaneamente.
 */
const calculateDelayWithJitter = (baseDelay: number): number => {
  const jitter = Math.floor(Math.random() * baseDelay * 0.3);
  // Distribui simetricamente: -15% a +15%
  return baseDelay - Math.floor(baseDelay * 0.15) + jitter;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Classifica o erro para decidir a estratégia de retry.
 *
 * Retorna:
 *  - 'rate-limit': erro 429, usa Retry-After header
 *  - 'server-error': 5xx, retry com backoff normal
 *  - 'client-error': 4xx (exceto 429), NÃO retenta
 *  - 'network-error': erro de rede/timeout, retry normal
 */
type ErrorKind = 'rate-limit' | 'server-error' | 'client-error' | 'network-error';

const classifyError = (error: Error): { kind: ErrorKind; retryAfterMs?: number } => {
  // Erro de RateLimitError (criado por quem parseou o 429)
  if (error instanceof RateLimitError) {
    return { kind: 'rate-limit', retryAfterMs: error.retryAfterMs };
  }

  const msg = error.message;

  // Tenta extrair HTTP status da mensagem de erro
  const httpMatch = msg.match(/HTTP\s*(\d{3})/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1]!, 10);

    if (status === 429) {
      // Tenta extrair Retry-After da mensagem (se injetado por quem fez a chamada)
      const retryMatch = msg.match(/Retry-After[:\s]*(\d+)/i);
      const retryAfterSec = retryMatch ? parseInt(retryMatch[1]!, 10) : 5;
      return { kind: 'rate-limit', retryAfterMs: retryAfterSec * 1000 };
    }

    if (status >= 500 && status < 600) {
      return { kind: 'server-error' };
    }

    // 4xx que não 429: não retenta
    if (status >= 400 && status < 500) {
      return { kind: 'client-error' };
    }
  }

  // Erro de timeout
  if (error instanceof TimeoutError || msg.includes('timeout') || msg.includes('Timeout')) {
    return { kind: 'network-error' };
  }

  // Default: erro de rede (DNS, conexão recusada, etc.)
  return { kind: 'network-error' };
};

// ─── withRetry ──────────────────────────────────────────────────────────────

/**
 * Executa uma função com retry inteligente:
 * - 429: espera Retry-After + jitter, até 3 tentativas
 * - 5xx: backoff exponencial com jitter
 * - 4xx (não 429): NÃO retenta (erro do cliente)
 * - Rede: backoff normal
 *
 * @example
 *   const html = await withRetry(() => fetchPage(url), {
 *     maxRetries: 3,
 *     initialDelay: 1000,
 *   });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Se timeout está configurado, aplica
      if (opts.timeout) {
        return await withTimeout(fn(), opts.timeout);
      }
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Última tentativa → lança
      if (attempt === opts.maxRetries) {
        if (opts.maxRetries > 0) {
          console.warn(
            `[retry] esgotado (${opts.maxRetries + 1}x): ${lastError.message.slice(0, 100)}`,
          );
        }
        throw lastError;
      }

      // Classifica o erro para decidir delay
      const { kind, retryAfterMs } = classifyError(lastError);

      // Erro de cliente (4xx não 429): não faz sentido retentar
      if (kind === 'client-error') {
        // 404 Yahoo/SI são esperados p/ tickers delistados — log curto
        if (!/HTTP 404/.test(lastError.message)) {
          console.warn(`[retry] client: ${lastError.message.slice(0, 100)}`);
        }
        throw lastError;
      }

      // Calcula delay
      let delayMs: number;
      if (kind === 'rate-limit' && retryAfterMs) {
        // 429: espera o Retry-After completo (sem retry agressivo em paralelo)
        const baseDelay = Math.max(
          retryAfterMs,
          opts.initialDelay * Math.pow(opts.backoffFactor, attempt),
        );
        delayMs = calculateDelayWithJitter(Math.min(baseDelay, opts.maxDelay));
        console.warn(
          `[retry] 429 → espera ${Math.round(delayMs / 1000)}s ` +
            `(${attempt + 1}/${opts.maxRetries})`,
        );
      } else {
        const baseDelay = opts.initialDelay * Math.pow(opts.backoffFactor, attempt);
        delayMs = calculateDelayWithJitter(Math.min(baseDelay, opts.maxDelay));
        console.warn(
          `[retry] ${kind === 'server-error' ? '5xx' : 'net'} ` +
            `${attempt + 1}/${opts.maxRetries} +${Math.round(delayMs / 1000)}s`,
        );
      }

      // Callback opcional
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, lastError, delayMs);
      }

      await sleep(delayMs);
    }
  }

  if (!lastError) {
    throw new Error('Retry failed without error');
  }
  throw lastError;
}

// ─── withTimeout ────────────────────────────────────────────────────────────

/**
 * Adiciona timeout a uma promise.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ─── batchWithConcurrency ───────────────────────────────────────────────────

/**
 * Executa operações em lotes com limite de concorrência.
 * Útil para processar N tickers sem disparar todas as chamadas de uma vez.
 *
 * @param items       Itens a processar
 * @param operation   Função assíncrona para cada item
 * @param concurrency Máximo de operações simultâneas (padrão: 2)
 */
export async function batchWithConcurrency<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
  concurrency: number = 2,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length);
  const executing: Promise<void>[] = [];

  for (const [index, item] of items.entries()) {
    // Um item que rejeita não pode derrubar o batch inteiro: sem este catch,
    // promises abandonadas em `executing` viram unhandled rejection e o Bun
    // mata o processo (visto em produção como socket hang up no /v1/analysis/ranking).
    const promise = operation(item)
      .then((result) => { results[index] = result; })
      .catch((err) => {
        console.error(`[batchWithConcurrency] item ${index} falhou:`, err instanceof Error ? err.message : err);
        results[index] = null;
      })
      .finally(() => {
        executing.splice(executing.indexOf(promise), 1);
      });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ─── fetchWithRetry (conveniência) ──────────────────────────────────────────

/**
 * Fetch wrapper que já trata 429 e injeta Retry-After na mensagem de erro.
 * Use no lugar de fetch() para obter retry inteligente automático.
 *
 * @example
 *   const res = await fetchWithRetry(url, { headers: {...} });
 *   const html = await res.text();
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retryOptions?: Partial<RetryOptions>,
): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(url, init);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retrySec = retryAfter ? parseInt(retryAfter, 10) || 5 : 5;
      throw new RateLimitError(
        `HTTP 429 Too Many Requests (Retry-After: ${retrySec}s)`,
        retrySec * 1000,
      );
    }

    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!response.ok) {
      // 4xx não 429: não retentar
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response;
  }, retryOptions);
}
