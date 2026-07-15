/**
 * Circuit Breaker — Protege chamadas HTTP contra falhas em cascata.
 *
 * Quando um serviço externo começa a retornar 429/5xx repetidamente,
 * o circuit breaker ABRE o circuito e bloqueia TODAS as chamadas
 * para aquele serviço por um período de "cooldown", evitando:
 *  - Piorar a situação (mais 429 geram mais throttling)
 *  - Desperdiçar recursos (requisições fadadas ao fracasso)
 *  - Degradação em cascata (timeouts acumulados travam o event loop)
 *
 * Estados:
 *   CLOSED    → operação normal, requisições passam
 *   OPEN      → circuito aberto, requisições são rejeitadas imediatamente
 *   HALF_OPEN → após cooldown, permite 1 requisição de teste
 *                - Se OK → CLOSED
 *                - Se erro → OPEN (reset do cooldown)
 *
 * Backend: Redis (estado compartilhado entre workers/processos).
 * Fallback: em memória (quando Redis está offline).
 */

import { redis } from './redis.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Nome do serviço (ex: 'statusinvest', 'yahoo-finance') */
  service: string;
  /** Número de falhas consecutivas para abrir o circuito (padrão: 5) */
  failureThreshold: number;
  /** Tempo em ms que o circuito fica aberto antes de tentar half-open (padrão: 60s) */
  cooldownMs: number;
  /** Timeout em ms para chamadas que passam pelo circuito (opcional) */
  timeoutMs?: number;
  /** Tipos de erro que contam como falha (padrão: ['rate-limit', 'server-error', 'network-error']) */
  failureTypes?: Array<'rate-limit' | 'server-error' | 'network-error'>;
}

interface CircuitStateData {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  lastFailureMessage: string;
  openedAt: number | null;
  totalSuccesses: number;
  totalFailures: number;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly config: {
    service: string;
    failureThreshold: number;
    cooldownMs: number;
    timeoutMs: number | undefined;
    failureTypes: Array<'rate-limit' | 'server-error' | 'network-error'>;
  };
  private readonly redisPrefix: string;

  // Cache em memória para fallback rápido (evita Redis a cada chamada)
  private memState: CircuitStateData | null = null;
  private memLastSync = 0;
  private readonly MEM_SYNC_TTL = 5000; // 5s — Redis é a fonte da verdade

  constructor(config: CircuitBreakerConfig) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      cooldownMs: config.cooldownMs ?? 60_000,
      timeoutMs: config.timeoutMs,
      failureTypes: config.failureTypes ?? ['rate-limit', 'server-error', 'network-error'],
      service: config.service,
    };
    this.redisPrefix = `circuit:${this.config.service}`;
  }

  /**
   * Verifica se a requisição pode prosseguir.
   *
   * @throws CircuitOpenError se o circuito estiver ABERTO
   * @returns void se OK (CLOSED ou HALF_OPEN com teste pendente)
   */
  async beforeRequest(): Promise<void> {
    const state = await this.getState();

    if (state.state === 'OPEN') {
      const elapsedSinceOpen = Date.now() - (state.openedAt ?? 0);
      if (elapsedSinceOpen >= this.config.cooldownMs) {
        // Transita para HALF_OPEN
        await this.setState('HALF_OPEN');
        return; // Permite a requisição de teste
      }

      const remainingMs = this.config.cooldownMs - elapsedSinceOpen;
      throw new CircuitOpenError(
        this.config.service,
        `Circuito ABERTO para ${this.config.service}. ` +
          `Reabre em ${Math.ceil(remainingMs / 1000)}s. ` +
          `Última falha: ${state.lastFailureMessage}`,
        remainingMs,
      );
    }

    // CLOSED ou HALF_OPEN: permite
  }

  /**
   * Registra sucesso da chamada.
   * Se estava HALF_OPEN, fecha o circuito.
   */
  async onSuccess(): Promise<void> {
    const state = await this.getState();

    if (state.state === 'HALF_OPEN') {
      await this.setState('CLOSED');
      console.log(`[circuit-breaker] ✅ ${this.config.service} → CLOSED (teste half-open OK)`);
      return;
    }

    // Incrementa contador de sucessos
    await this.updateCounters({ success: true });
  }

  /**
   * Registra falha da chamada.
   * Incrementa contador de falhas e pode abrir o circuito.
   *
   * @param errorKind  Tipo do erro ('rate-limit', 'server-error', 'network-error')
   * @param message    Mensagem descritiva
   */
  async onFailure(errorKind: string, message: string): Promise<void> {
    // Só conta falhas dos tipos configurados
    if (!this.config.failureTypes.includes(errorKind as any)) {
      return;
    }

    const state = await this.getState();

    if (state.state === 'HALF_OPEN') {
      // Teste half-open falhou → abre de novo
      await this.setState('OPEN', message);
      console.warn(
        `[circuit-breaker] ⚡ ${this.config.service} → OPEN ` +
          `(teste half-open falhou: ${message.slice(0, 80)})`,
      );
      return;
    }

    // CLOSED: incrementa falhas
    const newCount = state.failureCount + 1;
    await this.updateCounters({ success: false, failureMessage: message });

    if (newCount >= this.config.failureThreshold) {
      await this.setState('OPEN', message);
      console.warn(
        `[circuit-breaker] 🔴 ${this.config.service} → OPEN ` +
          `(${newCount} falhas consecutivas. ` +
          `Cooldown: ${this.config.cooldownMs / 1000}s). ` +
          `Última: ${message.slice(0, 80)}`,
      );
    }
  }

  /**
   * Executa uma função protegida pelo circuit breaker.
   *
   * @param fn        Função a executar
   * @param errorKind Tipo de erro em caso de falha (para classificação)
   */
  async execute<T>(
    fn: () => Promise<T>,
    errorKind: string = 'network-error',
  ): Promise<T> {
    await this.beforeRequest();

    try {
      const result = await fn();
      await this.onSuccess();
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Se já é CircuitOpenError, só propaga
      if (error instanceof CircuitOpenError) {
        throw error;
      }

      await this.onFailure(errorKind, msg);
      throw error;
    }
  }

  /** Retorna o estado atual (CLOSED/OPEN/HALF_OPEN) */
  async currentState(): Promise<CircuitState> {
    const state = await this.getState();
    return state.state;
  }

  /** Reseta manualmente o circuito para CLOSED */
  async reset(): Promise<void> {
    await this.setState('CLOSED');
    console.log(`[circuit-breaker] 🔄 ${this.config.service} → reset manual para CLOSED`);
  }

  // ─── Privados ──────────────────────────────────────────────────────────

  private redisKey(field: string): string {
    return `${this.redisPrefix}:${field}`;
  }

  private async getState(): Promise<CircuitStateData> {
    // Cache em memória para latência (5s)
    if (this.memState && (Date.now() - this.memLastSync) < this.MEM_SYNC_TTL) {
      return this.memState;
    }

    try {
      const raw = await redis.get(this.redisKey('state'));
      if (raw) {
        this.memState = JSON.parse(raw) as CircuitStateData;
        this.memLastSync = Date.now();
        return this.memState;
      }
    } catch {
      // Redis offline → usa memória ou default
    }

    // Estado default: CLOSED
    const defaultState: CircuitStateData = {
      state: 'CLOSED',
      failureCount: 0,
      lastFailureTime: 0,
      lastFailureMessage: '',
      openedAt: null,
      totalSuccesses: 0,
      totalFailures: 0,
    };

    this.memState = defaultState;
    this.memLastSync = Date.now();
    return defaultState;
  }

  private async setState(state: CircuitState, failureMessage?: string): Promise<void> {
    const now = Date.now();
    const current = await this.getState();

    const data: CircuitStateData = {
      state,
      failureCount: state === 'CLOSED' ? 0 : current.failureCount,
      lastFailureTime: failureMessage ? now : current.lastFailureTime,
      lastFailureMessage: failureMessage ?? current.lastFailureMessage,
      openedAt: state === 'OPEN' ? now : (state === 'CLOSED' ? null : current.openedAt),
      totalSuccesses: current.totalSuccesses,
      totalFailures: current.totalFailures,
    };

    // Persiste no Redis
    try {
      await redis.setex(this.redisKey('state'), 3600, JSON.stringify(data));
    } catch {
      // Redis offline
    }

    this.memState = data;
    this.memLastSync = Date.now();
  }

  private async updateCounters(opts: {
    success: boolean;
    failureMessage?: string;
  }): Promise<void> {
    const state = await this.getState();
    const now = Date.now();

    const data: CircuitStateData = {
      state: state.state,
      failureCount: opts.success ? 0 : state.failureCount + 1,
      lastFailureTime: opts.success ? state.lastFailureTime : now,
      lastFailureMessage: opts.success
        ? state.lastFailureMessage
        : (opts.failureMessage ?? state.lastFailureMessage),
      openedAt: state.openedAt,
      totalSuccesses: opts.success ? state.totalSuccesses + 1 : state.totalSuccesses,
      totalFailures: opts.success ? state.totalFailures : state.totalFailures + 1,
    };

    try {
      await redis.setex(this.redisKey('state'), 3600, JSON.stringify(data));
    } catch {
      // Redis offline
    }

    this.memState = data;
    this.memLastSync = Date.now();
  }
}

// ─── CircuitOpenError ────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  service: string;
  retryAfterMs: number;

  constructor(service: string, message: string, retryAfterMs: number) {
    super(message);
    this.name = 'CircuitOpenError';
    this.service = service;
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Circuit Breakers Pré-Configurados ───────────────────────────────────────

/** StatusInvest: abre após 5 falhas consecutivas de rate-limit, cooldown 120s */
export const statusInvestCircuitBreaker = new CircuitBreaker({
  service: 'statusinvest',
  failureThreshold: 5,
  cooldownMs: 120_000, // 2 minutos
  failureTypes: ['rate-limit', 'server-error'],
});

/** Yahoo Finance: abre após 3 falhas, cooldown 60s */
export const yahooCircuitBreaker = new CircuitBreaker({
  service: 'yahoo-finance',
  failureThreshold: 3,
  cooldownMs: 60_000, // 1 minuto
  failureTypes: ['rate-limit', 'server-error'],
});

/** CVM: abre após 3 falhas, cooldown 300s (dados grandes, espera mais) */
export const cvmCircuitBreaker = new CircuitBreaker({
  service: 'cvm',
  failureThreshold: 3,
  cooldownMs: 300_000, // 5 minutos
  failureTypes: ['server-error', 'network-error'],
});

// ─── Stats ───────────────────────────────────────────────────────────────────

/**
 * Retorna estatísticas de todos os circuit breakers.
 * Útil para endpoint de healthcheck.
 */
export async function getCircuitBreakerStats(): Promise<
  Record<string, CircuitStateData>
> {
  const breakers = [
    statusInvestCircuitBreaker,
    yahooCircuitBreaker,
    cvmCircuitBreaker,
  ];

  const stats: Record<string, CircuitStateData> = {};
  for (const breaker of breakers) {
    const key = (breaker as any).config?.service as string;
    if (key) {
      stats[key] = await (breaker as any).getState();
    }
  }
  return stats;
}
