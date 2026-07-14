/**
 * Job Scheduler — Loop de verificação e disparo de jobs pendentes.
 */

import { JobStore } from './job-store.ts';
import { JobWorker } from './worker.ts';
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

  constructor(
    private store: JobStore,
    private worker: JobWorker,
    private config: SchedulerConfig = DEFAULT_CONFIG,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(
      `[scheduler] Iniciado — intervalo ${this.config.checkInterval / 1000}s, ` +
      `concorrência ${this.config.maxConcurrentJobs}`,
    );

    // Reseta jobs travados de execuções anteriores
    const reset = await this.store.resetStuckJobs(this.config.staleTimeout);
    if (reset > 0) console.log(`[scheduler] ${reset} job(s) travado(s) resetado(s)`);

    // Primeira verificação imediata
    await this.tick();

    // Loop
    this.interval = setInterval(() => this.tick(), this.config.checkInterval);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    console.log('[scheduler] Parado');
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const available = this.config.maxConcurrentJobs - this.currentJobs;
      if (available <= 0) return;

      const dueJobs = await this.store.getJobsDue();
      if (dueJobs.length === 0) return;

      const toExecute = dueJobs.slice(0, available);
      const batchSize = toExecute.length;
      this.currentJobs += batchSize;

      console.log(`[scheduler] Disparando ${batchSize} job(s)`);

      // Fire and forget
      this.worker.executeJobs(toExecute, this.config.maxConcurrentJobs)
        .then((result) => {
          if (result.failed > 0) {
            console.warn(`[scheduler] Lote: ${result.success} ok, ${result.failed} falha(s)`);
          }
        })
        .catch((err) => {
          console.error('[scheduler] Erro no lote:', err);
        })
        .finally(() => {
          this.currentJobs = Math.max(0, this.currentJobs - batchSize);
        });
    } catch (error) {
      console.error('[scheduler] Erro no tick:', error);
      this.currentJobs = Math.max(0, this.currentJobs - 1);
    }
  }

  getStatus() {
    return {
      running: this.running,
      currentJobs: this.currentJobs,
      config: this.config,
    };
  }
}
