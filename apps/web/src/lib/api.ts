// Minimal API client for Urano backend.
// Base URL and API key are user-managed via Settings (localStorage).
// All requests attach `x-api-key` and surface backend error shape { error, message, details }.
//
// Dev (Vite): use same-origin base (http://localhost:8080). vite.config proxies /v1 → API :3333.
// That avoids CORS and Chrome Private Network Access blocks entirely.

const LS_BASE = "urano.api.baseUrl";
const LS_KEY = "urano.api.key";

/** Portas típicas da API — se o user apontou pra elas no dev, redireciona pro proxy. */
const API_DEV_PORTS = new Set(["3000", "3333"]);

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/**
 * Resolve a base URL efetiva.
 * - vazio / ausente → same-origin (proxy Vite em dev)
 * - aponta para porta da API (:3333/:3000) → same-origin (proxy; evita CORS/PNA)
 * - NÃO inclua /v1 na base — o client prefixa v1 em todo path
 */
function resolveBaseUrl(stored: string | null): string {
  if (!isBrowser()) return stored ?? "";
  const origin = window.location.origin;
  if (!stored || !stored.trim()) return origin;

  try {
    let raw = stored.trim().replace(/\/+$/, "");
    // Usuário colou .../v1 por engano → normaliza
    raw = raw.replace(/\/v1$/i, "");
    const u = new URL(raw);
    // Qualquer base na porta da API em dev → usar o front (Vite proxy /v1)
    if (API_DEV_PORTS.has(u.port)) {
      return origin;
    }
    return raw;
  } catch {
    return stored.replace(/\/+$/, "").replace(/\/v1$/i, "");
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isPrivateLan(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export const apiSettings = {
  getBaseUrl(): string {
    if (!isBrowser()) return "";
    return resolveBaseUrl(localStorage.getItem(LS_BASE));
  },
  /** Valor cru do localStorage (para o form de Settings). */
  getStoredBaseUrl(): string {
    if (!isBrowser()) return "";
    return localStorage.getItem(LS_BASE) ?? "";
  },
  getKey(): string {
    if (!isBrowser()) return "";
    return localStorage.getItem(LS_KEY) ?? "";
  },
  setBaseUrl(v: string) {
    const trimmed = v.trim().replace(/\/+$/, "");
    // Vazio = same-origin (recomendado em dev)
    if (!trimmed) {
      localStorage.removeItem(LS_BASE);
      window.dispatchEvent(new Event("urano:settings"));
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(
        "URL inválida. Deixe em branco (mesmo host do front) ou use ex.: http://localhost:8080",
      );
    }
    const host = parsed.hostname;
    const okHttp = isLoopback(host) || isPrivateLan(host);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && okHttp)) {
      throw new Error(
        "Use https:// (ou http:// para localhost / IP local). Em dev, deixe em branco ou use a URL do front (:8080).",
      );
    }
    localStorage.setItem(LS_BASE, trimmed);
    window.dispatchEvent(new Event("urano:settings"));
  },
  setKey(v: string) {
    localStorage.setItem(LS_KEY, v);
    window.dispatchEvent(new Event("urano:settings"));
  },
  isConfigured() {
    // Com same-origin default, base sempre resolve no browser; key é opcional p/ healthcheck
    return isBrowser();
  },
};

export type ApiErrorShape = {
  error?: string;
  message?: string;
  details?: unknown;
};

export class ApiError extends Error {
  status: number;
  payload: ApiErrorShape;
  constructor(status: number, payload: ApiErrorShape) {
    super(payload.message || payload.error || `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

export type ApiRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Se true, não envia x-api-key (rotas públicas como /healthcheck). */
  public?: boolean;
};

const API_VERSION = "v1";

function buildUrl(base: string, path: string, query?: ApiRequest["query"]) {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const root = base || (isBrowser() ? window.location.origin : "http://127.0.0.1:8080");
  const url = new URL(`${API_VERSION}/${cleanPath}`, root.endsWith("/") ? root : root + "/");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function apiFetch<T = unknown>(req: ApiRequest): Promise<T> {
  const base = apiSettings.getBaseUrl();
  const key = apiSettings.getKey();
  if (!base && !isBrowser()) {
    throw new ApiError(0, {
      error: "not_configured",
      message: "API Base URL não configurada. Vá em Settings.",
    });
  }
  const url = buildUrl(base, req.path, req.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (!req.public && key) headers["x-api-key"] = key;
  if (req.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? "GET",
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: req.signal,
    });
  } catch (e) {
    const msg = (e as Error).message || "Falha de rede ao contatar a API.";
    throw new ApiError(0, {
      error: "network",
      message:
        msg === "Failed to fetch"
          ? `Failed to fetch (${url}). Em dev use a URL do front (ex. http://localhost:8080) — o Vite faz proxy de /v1. API precisa estar em :3333.`
          : msg,
    });
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const payload = (data as ApiErrorShape) ?? {
      error: `http_${res.status}`,
      message: res.statusText,
    };
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("urano:unauthorized", { detail: payload }));
    }
    throw new ApiError(res.status, payload);
  }

  return data as T;
}

/** Ping público — não exige API key. Ideal para "Testar conexão". */
export async function pingHealthcheck(): Promise<{
  status: string;
  checks?: { database?: string; redis?: string };
  uptimeSeconds?: number;
}> {
  return apiFetch({ path: "/healthcheck", public: true });
}
