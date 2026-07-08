/**
 * Logger utilitário com timestamp GMT-3 (horário de Brasília).
 *
 * Formato: dd mm yyyy hh mm ss [tag] mensagem
 * Exemplo: 08 07 2026 11 45 30 [worker] ✅ PETR4 (stock) — 1200ms
 */

function brTz(date: Date): Date {
  return new Date(date.getTime() - 3 * 3600000);
}

function fmt(date: Date): string {
  const d = brTz(date);
  const dateStr = [String(d.getUTCDate()).padStart(2, '0'), String(d.getUTCMonth() + 1).padStart(2, '0'), d.getUTCFullYear()].join('/');
  const timeStr = [String(d.getUTCHours()).padStart(2, '0'), String(d.getUTCMinutes()).padStart(2, '0'), String(d.getUTCSeconds()).padStart(2, '0')].join(':');
  return `[${dateStr} ${timeStr}]`;
}

export function log(tag: string, message: string): void {
  console.log(`${fmt(new Date())} [${tag}] ${message}`);
}

export function warn(tag: string, message: string): void {
  console.warn(`${fmt(new Date())} [${tag}] ${message}`);
}

export function error(tag: string, message: string): void {
  console.error(`${fmt(new Date())} [${tag}] ${message}`);
}
