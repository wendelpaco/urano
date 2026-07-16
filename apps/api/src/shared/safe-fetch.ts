/**
 * safe-fetch.ts — Fetch wrapper com proteções SSRF.
 *
 * SSRF-3r: Não segue redirects (default = 'error') para evitar que um
 * 302 do upstream aponte o processo para host interno.
 *
 * SSRF-1: Valida Content-Length antes de ler o corpo e lê stream com
 * teto de bytes para prevenir OOM/zip-bomb.
 *
 * Uso:
 *   const text = await safeFetch(url, { maxBytes: 2 * 1024 * 1024 });
 *   const buf = await safeFetchBuffer(url, { maxBytes: 50 * 1024 * 1024 });
 */

export interface SafeFetchOptions {
  /** Limite máximo de bytes a ler do corpo da resposta (default: 2 MiB). */
  maxBytes?: number;
  /** Headers HTTP adicionais. */
  headers?: Record<string, string>;
  /** AbortSignal para timeout. */
  signal?: AbortSignal;
  /**
   * Redirecionamento: 'error' (default) rejeita qualquer redirect.
   * Use 'follow' apenas para endpoints confiáveis e com allowlist de host.
   */
  redirect?: 'error' | 'follow' | 'manual';
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Fetch com proteções SSRF. Retorna texto do corpo.
 * Lança se Content-Length exceder maxBytes ou se corpo lido ultrapassar limite.
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<string> {
  const { maxBytes = DEFAULT_MAX_BYTES, headers, signal, redirect = 'error' } = options;

  const response = await fetch(url, { headers, signal, redirect });

  // Verifica Content-Length antes de ler
  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > maxBytes) {
      throw new Error(
        `Resposta muito grande: Content-Length ${len} excede limite de ${maxBytes} bytes (${url})`,
      );
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  // Lê stream com teto
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          reader.cancel();
          throw new Error(
            `Resposta excedeu limite de ${maxBytes} bytes durante leitura (${url})`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Concatena chunks e decodifica
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}

/**
 * Fetch com proteções SSRF. Retorna ArrayBuffer.
 * Idêntico a safeFetch mas retorna buffer binário.
 */
export async function safeFetchBuffer(
  url: string,
  options: SafeFetchOptions = {},
): Promise<ArrayBuffer> {
  const { maxBytes = DEFAULT_MAX_BYTES, headers, signal, redirect = 'error' } = options;

  const response = await fetch(url, { headers, signal, redirect });

  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > maxBytes) {
      throw new Error(
        `Resposta muito grande: Content-Length ${len} excede limite de ${maxBytes} bytes (${url})`,
      );
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  // Para buffer, verificamos Content-Length e usamos arrayBuffer com teto
  // via stream manual se necessário
  const reader = response.body?.getReader();
  if (!reader) {
    return response.arrayBuffer();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          reader.cancel();
          throw new Error(
            `Resposta excedeu limite de ${maxBytes} bytes durante leitura (${url})`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined.buffer;
}
