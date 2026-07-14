// Minimal API client for Urano backend.
// Base URL and API key are user-managed via Settings (localStorage).
// All requests attach `x-api-key` and surface backend error shape { error, message, details }.

const LS_BASE = "urano.api.baseUrl";
const LS_KEY = "urano.api.key";

export const apiSettings = {
  getBaseUrl(): string {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(LS_BASE) ?? "";
  },
  getKey(): string {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(LS_KEY) ?? "";
  },
  setBaseUrl(v: string) {
    localStorage.setItem(LS_BASE, v.replace(/\/+$/, ""));
    window.dispatchEvent(new Event("urano:settings"));
  },
  setKey(v: string) {
    localStorage.setItem(LS_KEY, v);
    window.dispatchEvent(new Event("urano:settings"));
  },
  isConfigured() {
    return Boolean(this.getBaseUrl());
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
};

function buildUrl(base: string, path: string, query?: ApiRequest["query"]) {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, base + "/");
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
  if (!base) {
    throw new ApiError(0, {
      error: "not_configured",
      message: "API Base URL não configurada. Vá em Settings.",
    });
  }
  const url = buildUrl(base, req.path, req.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (key) headers["x-api-key"] = key;
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
    throw new ApiError(0, {
      error: "network",
      message: (e as Error).message || "Falha de rede ao contatar a API.",
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
