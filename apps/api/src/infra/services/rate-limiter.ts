/**
 * Rate Limiter Centralizado por Domínio
 *
 * TokenBucket compartilhado entre todos os serviços que batem no mesmo host.
 * Isso evita que múltiplos scrapers/workers estourem o rate limit do servidor.
 *
 * Características:
 * - Uma instância por domínio (ex: statusinvest.com.br, yahoo.com)
 * - Thread-safe via Promises (single-threaded JS, mas seguro para concorrência)
 * - Jitter opcional: adiciona aleatoriedade de até 20% no intervalo
 * - Estatísticas: total de aquisições, tempo de espera acumulado
 */

// ─── TokenBucket ─────────────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly refillRate: number; // tokens por ms
  private readonly maxTokens: number;
  private readonly jitter: boolean;

  // Stats (para monitoramento)
  public totalAcquisitions = 0;
  public totalWaitMs = 0;

  constructor(options: {
    /** Tokens por segundo (ex: 1.5 = 1 requisição a cada 667ms) */
    ratePerSecond: number;
    /** Máximo de tokens acumulados (permite pequena rajada inicial) */
    maxTokens?: number;
    /** Adiciona jitter de até 20% no tempo de espera */
    jitter?: boolean;
  }) {
    const rate = options.ratePerSecond;
    this.maxTokens = options.maxTokens ?? Math.max(2, Math.ceil(rate));
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = rate / 1000; // tokens por ms
    this.jitter = options.jitter ?? true;
  }

  /**
   * Aguarda até que um token esteja disponível e o consome.
   *
   * @returns O tempo de espera em ms (0 se token estava disponível)
   */
  async acquire(): Promise<number> {
    this.refill();
    this.totalAcquisitions++;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    // Calcula quanto tempo esperar até o próximo token
    let waitMs = Math.ceil((1 - this.tokens) / this.refillRate);

    // Adiciona jitter: +0% a +20% aleatório para evitar thundering herd
    if (this.jitter && waitMs > 0) {
      const jitterAmount = Math.floor(Math.random() * waitMs * 0.2);
      waitMs += jitterAmount;
    }

    this.totalWaitMs += waitMs;
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    this.tokens = 0;
    this.lastRefill = Date.now();
    return waitMs;
  }

  /** Retorna ms estimados até próximo token (sem esperar) */
  estimateWait(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ─── Registro Central de Rate Limiters ──────────────────────────────────────

/**
 * RateLimiterRegistry mantém UMA instância de TokenBucket por domínio.
 *
 * Uso:
 *   const limiter = rateLimiterRegistry.get('statusinvest.com.br');
 *   await limiter.acquire();
 *   // faz a requisição...
 */
class RateLimiterRegistry {
  private buckets = new Map<string, TokenBucket>();

  /**
   * Obtém (ou cria) o rate limiter para um domínio.
   *
   * @param domain   Domínio do serviço (ex: 'statusinvest.com.br')
   * @param ratePerSecond  Requisições por segundo permitidas
   * @param maxTokens      Máximo de tokens acumulados (rajada inicial)
   */
  get(
    domain: string,
    ratePerSecond: number,
    maxTokens?: number,
  ): TokenBucket {
    const existing = this.buckets.get(domain);
    if (existing) return existing;

    const bucket = new TokenBucket({ ratePerSecond, maxTokens, jitter: true });
    this.buckets.set(domain, bucket);
    return bucket;
  }

  /** Lista todos os domínios registrados com suas estatísticas */
  getStats(): Record<string, { acquired: number; totalWaitMs: number; estimatedWaitMs: number }> {
    const stats: Record<string, { acquired: number; totalWaitMs: number; estimatedWaitMs: number }> = {};
    for (const [domain, bucket] of this.buckets) {
      stats[domain] = {
        acquired: bucket.totalAcquisitions,
        totalWaitMs: bucket.totalWaitMs,
        estimatedWaitMs: bucket.estimateWait(),
      };
    }
    return stats;
  }
}

/** Singleton — use esta instância em toda a aplicação */
export const rateLimiterRegistry = new RateLimiterRegistry();

// ─── Limitadores pré-configurados ───────────────────────────────────────────

/**
 * StatusInvest: generoso em limites explícitos, mas na prática começa a
 * retornar 429 acima de ~2 req/s sustentadas. Usamos 1.5 req/s com
 * rajada inicial de 2 para equilibrar velocidade e segurança.
 */
export const statusInvestLimiter = rateLimiterRegistry.get(
  'statusinvest.com.br',
  1.5,  // req/s
  2,    // max tokens
);

/**
 * Yahoo Finance v8 (chart API): uso razoável gratuito.
 * ~5 req/s é seguro; rajada de 5 permite carregar dashboard rapidamente.
 */
export const yahooLimiter = rateLimiterRegistry.get(
  'query1.finance.yahoo.com',
  5,  // req/s
  5,  // max tokens
);

/**
 * CVM (dados.cvm.gov.br): dados públicos, ZIP de 12MB.
 * 1 req/s é conservador; raramente falha por rate limit.
 */
export const cvmLimiter = rateLimiterRegistry.get(
  'dados.cvm.gov.br',
  1,  // req/s
  1,  // max tokens
);

/**
 * Fundamentus (fundamentus.com.br): site clássico brasileiro.
 * 2 req/s — mais tolerante que StatusInvest.
 */
export const fundamentusLimiter = rateLimiterRegistry.get(
  'www.fundamentus.com.br',
  2,  // req/s
  2,  // max tokens
);
