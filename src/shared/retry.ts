/**
 * Retry Utility
 * Implementa lógica de retry com exponential backoff
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface RetryOptions {
  maxRetries: number;
  initialDelay: number; // ms
  maxDelay: number; // ms
  backoffFactor: number;
  timeout?: number; // ms
  onRetry?: (attempt: number, error: Error) => void;
}

const defaultOptions: RetryOptions = {
  maxRetries: 1,
  initialDelay: 500,
  maxDelay: 2000,
  backoffFactor: 2,
};

/**
 * Calcula o delay para a próxima tentativa usando exponential backoff
 */
const calculateDelay = (attempt: number, options: RetryOptions): number => {
  const delay = options.initialDelay * Math.pow(options.backoffFactor, attempt);
  return Math.min(delay, options.maxDelay);
};

/**
 * Sleep helper
 */
const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Executa uma função com retry e exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
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

      // Se é a última tentativa, lança o erro
      if (attempt === opts.maxRetries) {
        console.warn(`[retry] Máximo de tentativas excedido (${attempt + 1}): ${lastError.message}`);
        throw lastError;
      }

      // Calcula delay e aguarda
      const delay = calculateDelay(attempt, opts);

      console.warn(`[retry] Tentativa ${attempt + 1}/${opts.maxRetries} em ${delay}ms: ${lastError.message}`);

      // Callback opcional
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, lastError);
      }

      await sleep(delay);
    }
  }

  // lastError deve estar definido aqui pois maxRetries > 0
  if (!lastError) {
    throw new Error('Retry failed without error');
  }
  throw lastError;
}

/**
 * Adiciona timeout a uma promise
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: Timer | undefined;

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

/**
 * Executa operações em lotes com limite de concorrência
 */
export async function batchWithConcurrency<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
  concurrency: number = 5
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const promise = operation(item).then((result) => {
      results.push(result);
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
