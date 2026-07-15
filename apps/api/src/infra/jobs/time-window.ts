/**
 * Time Window — Controle de horário para jobs pesados.
 *
 * Permite restringir jobs de ETL (como sincronização da CVM) para
 * horários de menor uso do sistema, tipicamente madrugada.
 *
 * Isso evita:
 *  - Competir por banda com usuários
 *  - Piorar rate limits em horários de pico
 *  - Alertas falsos de downtime (CVM pode ter manutenção de madrugada)
 *
 * Uso:
 *   const window = new TimeWindow('02:00', '06:00', 'America/Sao_Paulo');
 *   if (window.isOpen()) { /* executa job pesado *\/ }
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface TimeWindowConfig {
  /** Hora de início no formato HH:MM (ex: '02:00') */
  startTime: string;
  /** Hora de término no formato HH:MM (ex: '06:00') */
  endTime: string;
  /** Timezone IANA (ex: 'America/Sao_Paulo', 'UTC') */
  timezone: string;
  /** Dias da semana permitidos (0=Dom, 1=Seg, ..., 6=Sáb). undefined = todos */
  allowedDays?: number[];
}

// ─── Time Window ─────────────────────────────────────────────────────────────

export class TimeWindow {
  private readonly startMinutes: number;
  private readonly endMinutes: number;
  private readonly timezone: string;
  private readonly allowedDays: Set<number> | null;

  constructor(config: TimeWindowConfig) {
    this.startMinutes = this.parseTime(config.startTime);
    this.endMinutes = this.parseTime(config.endTime);
    this.timezone = config.timezone;
    this.allowedDays = config.allowedDays
      ? new Set(config.allowedDays)
      : null;
  }

  /**
   * Verifica se a janela está aberta AGORA.
   */
  isOpen(): boolean {
    const now = this.getLocalTime();

    // Verifica dia da semana
    if (this.allowedDays !== null) {
      if (!this.allowedDays.has(now.getDay())) {
        return false;
      }
    }

    // Verifica horário
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    return currentMinutes >= this.startMinutes && currentMinutes < this.endMinutes;
  }

  /**
   * Retorna quantos minutos faltam para a janela abrir.
   * Se a janela está aberta, retorna 0.
   * Se hoje a janela já fechou, retorna minutos até abrir amanhã.
   */
  minutesUntilOpen(): number {
    const now = this.getLocalTime();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const currentDay = now.getDay();

    // Se está aberta AGORA, retorna 0
    if (this.isOpen()) return 0;

    // Calcula minutos até abrir
    if (currentMinutes < this.startMinutes) {
      // Abre hoje ainda
      // Verifica dia permitido
      if (this.isDayAllowed(currentDay)) {
        return this.startMinutes - currentMinutes;
      }
    }

    // Já passou do horário ou dia não permitido: calcula até o próximo dia permitido
    return this.minutesUntilNextOpenDay(currentDay, currentMinutes);
  }

  /**
   * Retorna descrição legível do estado atual.
   */
  getStatus(): { open: boolean; minutesUntilOpen: number; description: string } {
    const open = this.isOpen();
    const minutesUntilOpen = this.minutesUntilOpen();

    let description: string;
    if (open) {
      description = `Janela ABERTA (fecha às ${this.formatMinutes(this.endMinutes)})`;
    } else if (minutesUntilOpen <= 60) {
      description = `Janela FECHADA (abre em ${minutesUntilOpen} min, às ${this.formatMinutes(this.startMinutes)})`;
    } else {
      const hours = Math.floor(minutesUntilOpen / 60);
      const mins = minutesUntilOpen % 60;
      description = `Janela FECHADA (abre em ${hours}h${mins}m)`;
    }

    return { open, minutesUntilOpen, description };
  }

  // ─── Privados ──────────────────────────────────────────────────────────

  private parseTime(time: string): number {
    const [h, m] = time.split(':').map(Number);
    if (h === undefined || m === undefined || h < 0 || h > 23 || m < 0 || m > 59) {
      throw new Error(`Horário inválido: ${time}. Use formato HH:MM (00:00 a 23:59).`);
    }
    return h * 60 + m;
  }

  private formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private getLocalTime(): Date {
    // Usa Intl para obter hora local no timezone configurado
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };

    let day = 0;
    let hour = 0;
    let minute = 0;

    for (const part of parts) {
      if (part.type === 'weekday') {
        day = dayMap[part.value] ?? 0;
      } else if (part.type === 'hour') {
        hour = parseInt(part.value, 10);
      } else if (part.type === 'minute') {
        minute = parseInt(part.value, 10);
      }
    }

    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    // Sobrescreve o dia da semana para o cálculo correto
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0);
  }

  private isDayAllowed(day: number): boolean {
    if (this.allowedDays === null) return true;
    return this.allowedDays.has(day);
  }

  private minutesUntilNextOpenDay(currentDay: number, currentMinutes: number): number {
    // Procura o próximo dia permitido
    for (let offset = 0; offset <= 7; offset++) {
      const checkDay = (currentDay + offset) % 7;
      if (this.isDayAllowed(checkDay)) {
        // Se é hoje e ainda não passou do horário, já teria retornado antes
        if (offset === 0 && currentMinutes < this.startMinutes) {
          return this.startMinutes - currentMinutes;
        }
        // Próximo dia permitido: minutos até meia-noite + startMinutes + offset * 24h
        const minutesUntilMidnight = 24 * 60 - currentMinutes;
        const daysToAdd = offset === 0 ? 0 : offset - 1;
        return minutesUntilMidnight + (daysToAdd * 24 * 60) + this.startMinutes;
      }
    }

    // Fallback (nunca deve chegar aqui)
    return 24 * 60;
  }
}

// ─── Janelas pré-configuradas ────────────────────────────────────────────────

/**
 * Janela para ETL pesado (CVM, sincronização de fundamentos).
 * Madrugada: 01:00 às 05:00, horário de Brasília.
 * Dias úteis (Seg-Sex).
 */
export const etlWindow = new TimeWindow({
  startTime: '01:00',
  endTime: '05:00',
  timezone: 'America/Sao_Paulo',
  allowedDays: [1, 2, 3, 4, 5], // Seg-Sex
});

/**
 * Janela para snapshot diário (worker de dados de mercado).
 * Madrugada: 02:00 às 04:00, todos os dias.
 */
export const snapshotWindow = new TimeWindow({
  startTime: '02:00',
  endTime: '04:00',
  timezone: 'America/Sao_Paulo',
  // Todos os dias
});
