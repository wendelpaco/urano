/**
 * SELIC provider — busca a taxa SELIC atual da API do Banco Central.
 *
 * Cache Redis 24h + fallback em memória. O valor é usado no score de ações
 * (valuation: earnings yield vs SELIC) e em telas macro.
 *
 * IMP-1: substitui o hardcoded 14.0 por valor real do BCB.
 */

import { withRetry } from '../../shared/retry.ts';
import { redis } from './redis.ts';

const BCB_SELIC_URL =
  'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4189/dados?formato=json';

const CACHE_KEY = 'macro:selic:current';
const CACHE_TTL = 86_400; // 24h

/** Fallback em memória — evita rede no hot path se Redis estiver offline. */
let memoryFallback: number | null = null;
let memoryFallbackAt = 0;

interface BcbPoint {
  data: string;
  valor: string;
}

async function fetchFromBcb(): Promise<number> {
  const data = await withRetry(async () => {
    const r = await fetch(BCB_SELIC_URL, { redirect: 'error' });
    if (!r.ok) throw new Error(`BCB HTTP ${r.status}`);
    return (await r.json()) as BcbPoint[];
  }, { maxRetries: 2, initialDelay: 500, maxDelay: 3000, timeout: 10_000 });

  if (!data.length) throw new Error('BCB retornou série vazia para SELIC');

  // Último valor disponível
  const last = data[data.length - 1]!;
  const value = parseFloat(last.valor.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`SELIC inválida: ${last.valor}`);
  }
  return value;
}

/**
 * Retorna a taxa SELIC atual (% a.a.).
 * Cache Redis 24h com fallback em memória. Nunca lança — retorna null se
 * todos os backends falharem (caller decide fallback).
 */
export async function getSelicRate(): Promise<number | null> {
  // 1. Redis cache
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const val = parseFloat(cached);
      if (Number.isFinite(val) && val > 0) return val;
    }
  } catch { /* Redis offline */ }

  // 2. Memory fallback (TTL 1h, mais curto que Redis)
  if (memoryFallback !== null && Date.now() - memoryFallbackAt < 3600_000) {
    return memoryFallback;
  }

  // 3. Fetch
  try {
    const selic = await fetchFromBcb();
    // Persiste cache
    try { await redis.setex(CACHE_KEY, CACHE_TTL, String(selic)); } catch { /* ok */ }
    memoryFallback = selic;
    memoryFallbackAt = Date.now();
    return selic;
  } catch (err) {
    console.warn('[SELIC] Indisponível:', (err as Error).message);
    // Se tínhamos fallback antigo, usa mesmo expirado (melhor que nada)
    if (memoryFallback !== null) return memoryFallback;
    return null;
  }
}
