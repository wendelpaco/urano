import Redis from 'ioredis';
import { env } from '../../config/env.ts';

/**
 * Cliente Redis para cache de cotações e dados voláteis.
 *
 * Configurações:
 *  - lazyConnect: true → só conecta no primeiro uso (evita crash se Redis offline)
 *  - maxRetriesPerRequest: 3 → tolerância para falhas de rede
 *  - retryDelayOnFailover: 100 → backoff rápido
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null; // desiste após 5 tentativas
    return Math.min(times * 200, 2000);
  },
});

/**
 * Verifica conectividade com o Redis.
 * Não lança erro se indisponível — o sistema opera em modo degradado.
 */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    await redis.ping();
    console.log('[Redis] ✅ Conexão estabelecida');
    return true;
  } catch {
    console.warn('[Redis] ⚠️ Indisponível — operando sem cache de cotações');
    return false;
  }
}

/**
 * Helper: busca do cache ou executa factory e armazena.
 *
 * @param key      Chave do cache
 * @param ttlSeconds Tempo de vida em segundos
 * @param factory  Função que gera o valor se não estiver em cache
 */
export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  factory: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
  } catch {
    // Redis indisponível, segue sem cache
  }

  const value = await factory();

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Falha ao gravar cache não é crítica
  }

  return value;
}
