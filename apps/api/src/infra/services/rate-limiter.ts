/**
 * Rate Limiter Centralizado por Domínio
 *
 * TokenBucket serializado (fila) — evita thundering herd quando N corrotinas
 * chamam acquire() ao mesmo tempo (warmup + scheduler + requests HTTP).
 */

// ─── TokenBucket ─────────────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly refillRate: number; // tokens por ms
  private readonly maxTokens: number;
  private readonly jitter: boolean;

  /** Fila de aquisição — garante serialização entre awaiters concorrentes */
  private chain: Promise<void> = Promise.resolve();

  /** Pausa extra após 429 (ms absoluto no relógio) */
  private penaltyUntil = 0;

  public totalAcquisitions = 0;
  public totalWaitMs = 0;
  public totalPenalties = 0;

  constructor(options: {
    /** Tokens por segundo (ex: 0.5 = 1 req a cada 2s) */
    ratePerSecond: number;
    /** Máximo de tokens acumulados (rajada). Prefira 1 em fontes sensíveis. */
    maxTokens?: number;
    jitter?: boolean;
  }) {
    const rate = options.ratePerSecond;
    this.maxTokens = options.maxTokens ?? 1;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = rate / 1000;
    this.jitter = options.jitter ?? true;
  }

  /**
   * Aguarda até que um token esteja disponível e o consome.
   * Serializado: só um waiter avança por vez.
   */
  async acquire(): Promise<number> {
    const run = async (): Promise<number> => {
      this.totalAcquisitions++;
      let waited = 0;

      // Respeita penalty de 429 global
      const now0 = Date.now();
      if (this.penaltyUntil > now0) {
        const p = this.penaltyUntil - now0;
        await sleep(p);
        waited += p;
      }

      this.refill();

      if (this.tokens < 1) {
        let waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
        if (this.jitter && waitMs > 0) {
          waitMs += Math.floor(Math.random() * waitMs * 0.2);
        }
        // Floor mínimo 50ms evita spin
        waitMs = Math.max(50, waitMs);
        await sleep(waitMs);
        waited += waitMs;
        this.refill();
      }

      this.tokens = Math.max(0, this.tokens - 1);
      this.totalWaitMs += waited;
      return waited;
    };

    // Encadeia na fila (mutex por promise)
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Após HTTP 429: congela o bucket por `ms` (ex.: Retry-After).
   * Novas aquisições esperam o penalty antes de liberar tokens.
   */
  penalize(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.penaltyUntil) {
      this.penaltyUntil = until;
      this.tokens = 0;
      this.totalPenalties++;
      console.warn(
        `[rate-limit] ⏸️ penalty ${Math.round(ms / 1000)}s (bucket pausado até o Retry-After)`,
      );
    }
  }

  estimateWait(): number {
    this.refill();
    const penaltyLeft = Math.max(0, this.penaltyUntil - Date.now());
    if (this.tokens >= 1 && penaltyLeft === 0) return 0;
    const tokenWait =
      this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillRate);
    return Math.max(penaltyLeft, tokenWait);
  }

  private refill(): void {
    const now = Date.now();
    // Não recarrega tokens durante penalty
    if (now < this.penaltyUntil) {
      this.lastRefill = now;
      return;
    }
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Registro ────────────────────────────────────────────────────────────────

class RateLimiterRegistry {
  private buckets = new Map<string, TokenBucket>();

  get(domain: string, ratePerSecond: number, maxTokens?: number): TokenBucket {
    const existing = this.buckets.get(domain);
    if (existing) return existing;
    const bucket = new TokenBucket({ ratePerSecond, maxTokens, jitter: true });
    this.buckets.set(domain, bucket);
    return bucket;
  }

  getStats(): Record<
    string,
    { acquired: number; totalWaitMs: number; estimatedWaitMs: number; penalties: number }
  > {
    const stats: Record<
      string,
      { acquired: number; totalWaitMs: number; estimatedWaitMs: number; penalties: number }
    > = {};
    for (const [domain, bucket] of this.buckets) {
      stats[domain] = {
        acquired: bucket.totalAcquisitions,
        totalWaitMs: bucket.totalWaitMs,
        estimatedWaitMs: bucket.estimateWait(),
        penalties: bucket.totalPenalties,
      };
    }
    return stats;
  }
}

export const rateLimiterRegistry = new RateLimiterRegistry();

// ─── Pré-configurados ────────────────────────────────────────────────────────

/**
 * StatusInvest: na prática 429 em rajadas > ~1 req/s.
 * 0.5 req/s + maxTokens=1 + fila serial = ~1 req a cada 2s, sem burst.
 */
export const statusInvestLimiter = rateLimiterRegistry.get(
  'statusinvest.com.br',
  0.5,
  1,
);

/** Yahoo chart: um pouco mais permissivo, mas sem rajada grande. */
export const yahooLimiter = rateLimiterRegistry.get(
  'query1.finance.yahoo.com',
  2,
  2,
);

/**
 * Investidor10 JSON (batch/chart): primária de cotação.
 * Conservador — site comercial, evita 429 em warmup.
 */
export const investidor10Limiter = rateLimiterRegistry.get(
  'investidor10.com.br',
  1,
  1,
);

export const cvmLimiter = rateLimiterRegistry.get('dados.cvm.gov.br', 1, 1);

export const fundamentusLimiter = rateLimiterRegistry.get(
  'www.fundamentus.com.br',
  1,
  1,
);
