/**
 * Job Scheduler — Loop de verificação e disparo de jobs pendentes.
 */

import type { JobStore } from './job-store.ts';
import type { JobWorker } from './worker.ts';
import type { SchedulerConfig } from './types.ts';

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: true,
  checkInterval: 30_000, // 30 segundos
  maxConcurrentJobs: 3,
  staleTimeout: 300_000, // 5 minutos
};

export class JobScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentJobs = 0;
  private tickInFlight: Promise<void> | null = null;
  private readonly activeBatches = new Set<Promise<void>>();

  constructor(
    private store: JobStore,
    private worker: JobWorker,
    private config: SchedulerConfig = DEFAULT_CONFIG,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.config.enabled) {
      console.log('[scheduler] Desabilitado por configuração');
      return;
    }

    this.running = true;

    console.log(
      `[scheduler] Iniciado — intervalo ${this.config.checkInterval / 1000}s, ` +
      `concorrência ${this.config.maxConcurrentJobs}`,
    );

    try {
      // Primeira verificação imediata
      await this.runTick();

      // stop() pode ter sido solicitado enquanto o primeiro claim aguardava DB.
      if (!this.running) return;

      // Loop. runTick evita ticks sobrepostos quando o banco está lento.
      this.interval = setInterval(() => {
        void this.runTick();
      }, this.config.checkInterval);
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.tickInFlight && this.activeBatches.size === 0) return;
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Um tick pode estar entre o claim e o dispatch. Esperá-lo garante que ele
    // libere o claim ou registre o batch antes de capturarmos activeBatches.
    if (this.tickInFlight) {
      await this.tickInFlight;
    }

    const active = [...this.activeBatches];
    if (active.length > 0) {
      console.log(`[scheduler] Aguardando ${active.length} lote(s) ativo(s)…`);
      await Promise.allSettled(active);
    }

    console.log('[scheduler] Parado');
  }

  private runTick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;

    const task = this.tick()
      .catch((error) => {
        console.error('[scheduler] Erro no tick:', error);
      })
      .finally(() => {
        if (this.tickInFlight === task) this.tickInFlight = null;
      });

    this.tickInFlight = task;
    return task;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Reaper periódico de leases expirados. Jobs vivos renovam updatedAt.
    const reset = await this.store.resetStuckJobs(this.config.staleTimeout);
    if (reset > 0) console.log(`[scheduler] ${reset} lease(s) expirado(s) liberado(s)`);

    const available = this.config.maxConcurrentJobs - this.currentJobs;
    if (available <= 0) return;

    const claimed = await this.store.claimJobsDue(available);
    if (claimed.length === 0) return;

    // Shutdown iniciado enquanto o banco fazia o claim: não abandona jobs em running.
    if (!this.running) {
      await this.store.releaseClaims(claimed.map((job) => job.id));
      return;
    }

    const batchSize = claimed.length;
    this.currentJobs += batchSize;
    console.log(`[scheduler] Disparando ${batchSize} job(s)`);

    const batch = this.worker.executeJobs(claimed, this.config.maxConcurrentJobs)
      .then((result) => {
        if (result.failed > 0 || result.partial > 0) {
          console.warn(
            `[scheduler] Lote: ${result.success} ok, ${result.partial} parcial(is), ` +
            `${result.failed} falha(s)`,
          );
        }
      })
      .catch((error) => {
        console.error('[scheduler] Erro durável no lote:', error);
      })
      .finally(() => {
        this.currentJobs = Math.max(0, this.currentJobs - batchSize);
      });

    const tracked = batch.finally(() => {
      this.activeBatches.delete(tracked);
    });
    this.activeBatches.add(tracked);
  }

  getStatus() {
    return {
      running: this.running,
      currentJobs: this.currentJobs,
      config: this.config,
    };
  }
}
