/**
 * User-Agent Pool — Rotação inteligente de User-Agents e headers HTTP.
 *
 * Simula comportamento de navegadores reais para dificultar
 * detecção de scraping por servidores como StatusInvest.
 *
 * Estratégias:
 *  1. Pool de 20+ User-Agents reais (Chrome, Firefox, Safari, Edge)
 *     nas plataformas Windows, macOS e Linux.
 *  2. Headers complementares variáveis:
 *     - Accept-Language (pt-BR, en-US, es-ES)
 *     - Accept-Encoding (gzip, br)
 *     - Sec-Ch-UA (marca/navegador para Chrome)
 *     - Viewport/Sec-Ch-Viewport
 *  3. Rotação round-robin com pesos: UAs mais recentes têm prioridade
 *  4. Estatísticas: qual UA foi usado, taxa de sucesso, etc.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface UserAgentEntry {
  ua: string;
  platform: 'windows' | 'macos' | 'linux';
  browser: 'chrome' | 'firefox' | 'safari' | 'edge';
  /** Versão maior do navegador (ex: 131) — usada para ordenar */
  version: number;
  /** Peso: UAs mais recentes têm peso maior (mais comuns em produção) */
  weight: number;
  /** Número de vezes que este UA foi usado */
  useCount: number;
  /** Número de erros com este UA */
  errorCount: number;
  /** Timestamp do último uso */
  lastUsed: number;
}

export interface RequestFingerprint {
  'User-Agent': string;
  'Accept': string;
  'Accept-Language': string;
  'Accept-Encoding': string;
  'Sec-CH-UA'?: string;
  'Sec-CH-UA-Platform'?: string;
  'Sec-CH-UA-Mobile'?: string;
  'Referer'?: string;
}

// ─── Pool de User-Agents ────────────────────────────────────────────────────

/**
 * User-Agents reais extraídos de navegadores em produção (Q1 2026).
 * Ordenados por versão (mais recente primeiro = maior peso).
 */
const USER_AGENTS: Omit<UserAgentEntry, 'useCount' | 'errorCount' | 'lastUsed'>[] = [
  // Chrome 131 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'windows', browser: 'chrome', version: 131, weight: 3 },
  // Chrome 131 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'macos', browser: 'chrome', version: 131, weight: 3 },
  // Chrome 130 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'windows', browser: 'chrome', version: 130, weight: 2 },
  // Chrome 130 — Linux
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'linux', browser: 'chrome', version: 130, weight: 2 },
  // Chrome 129 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', platform: 'macos', browser: 'chrome', version: 129, weight: 2 },
  // Firefox 133 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0', platform: 'windows', browser: 'firefox', version: 133, weight: 2 },
  // Firefox 133 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0', platform: 'macos', browser: 'firefox', version: 133, weight: 2 },
  // Firefox 132 — Linux
  { ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', platform: 'linux', browser: 'firefox', version: 132, weight: 1 },
  // Edge 131 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', platform: 'windows', browser: 'edge', version: 131, weight: 2 },
  // Edge 130 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', platform: 'macos', browser: 'edge', version: 130, weight: 1 },
  // Safari 18.2 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15', platform: 'macos', browser: 'safari', version: 18, weight: 2 },
  // Safari 18.1 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', platform: 'macos', browser: 'safari', version: 18, weight: 1 },
  // Chrome 128 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', platform: 'windows', browser: 'chrome', version: 128, weight: 1 },
  // Chrome 128 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', platform: 'macos', browser: 'chrome', version: 128, weight: 1 },
  // Firefox 131 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', platform: 'windows', browser: 'firefox', version: 131, weight: 1 },
  // Edge 129 — Windows
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', platform: 'windows', browser: 'edge', version: 129, weight: 1 },
  // Chrome 127 — Linux
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36', platform: 'linux', browser: 'chrome', version: 127, weight: 1 },
  // Chrome 131 — Linux
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'linux', browser: 'chrome', version: 131, weight: 2 },
  // Firefox 130 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0', platform: 'macos', browser: 'firefox', version: 130, weight: 1 },
  // Safari 17.6 — macOS
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', platform: 'macos', browser: 'safari', version: 17, weight: 1 },
];

// ─── Accept-Language ─────────────────────────────────────────────────────────

const LANGUAGES = [
  'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'pt-BR,pt;q=0.9,en;q=0.8',
  'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
  'pt-BR,pt;q=0.9,es-ES;q=0.8,es;q=0.7',
  'en-US,en;q=0.9,es;q=0.8,pt;q=0.7',
];

// ─── User-Agent Pool Manager ────────────────────────────────────────────────

export class UserAgentPool {
  private entries: UserAgentEntry[];
  private pointer = 0;

  constructor() {
    this.entries = USER_AGENTS.map((e) => ({
      ...e,
      useCount: 0,
      errorCount: 0,
      lastUsed: 0,
    }));
  }

  /**
   * Obtém o próximo User-Agent usando round-robin ponderado.
   *
   * Prioriza:
   * 1. UAs sem erros recentes (últimos 5 min)
   * 2. UAs com maior peso (versões mais recentes)
   * 3. UAs menos usados recentemente
   */
  getNext(): UserAgentEntry {
    const now = Date.now();
    const RECENT_ERROR_WINDOW = 5 * 60 * 1000; // 5 minutos

    // Filtra UAs que tiveram erro nos últimos 5 min
    const safe = this.entries.filter((e) => {
      if (e.errorCount === 0) return true;
      // Se teve erro, só usa de novo após 5 min
      return (now - e.lastUsed) > RECENT_ERROR_WINDOW;
    });

    // Se todos tiveram erro recente, usa todos mesmo assim
    const pool = safe.length > 0 ? safe : this.entries;

    // Ordena por: peso (desc), useCount (asc), lastUsed (asc)
    pool.sort((a, b) => {
      // Peso maior primeiro
      if (a.weight !== b.weight) return b.weight - a.weight;
      // Menos usado primeiro
      if (a.useCount !== b.useCount) return a.useCount - b.useCount;
      // Mais antigo primeiro (mais tempo desde último uso)
      return a.lastUsed - b.lastUsed;
    });

    // Pega o melhor (índice 0 após ordenação)
    const entry = pool[0]!;
    entry.useCount++;
    entry.lastUsed = now;
    return entry;
  }

  /**
   * Obtém um fingerprint completo (headers HTTP) simulando um navegador real.
   *
   * @param referer URL de referência (opcional, mas recomendado para parecer navegação real)
   */
  getFingerprint(referer?: string): RequestFingerprint {
    const entry = this.getNext();
    const ua = entry.ua;
    const isChrome = ua.includes('Chrome') && !ua.includes('Edg/');
    const isEdge = ua.includes('Edg/');
    const isChromium = isChrome || isEdge;

    const lang = LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)]!;

    const fingerprint: RequestFingerprint = {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': lang,
      'Accept-Encoding': 'gzip, deflate, br',
    };

    // Headers Sec-CH-UA (apenas Chromium)
    if (isChromium) {
      const brand = isEdge ? '"Microsoft Edge"' : '"Google Chrome"';
      const version = String(entry.version);
      fingerprint['Sec-CH-UA'] = `${brand};v="${version}", "Chromium";v="${version}", "Not_A Brand";v="24"`;

      const platform = entry.platform === 'macos'
        ? '"macOS"'
        : entry.platform === 'linux'
          ? '"Linux"'
          : '"Windows"';
      fingerprint['Sec-CH-UA-Platform'] = platform;
      fingerprint['Sec-CH-UA-Mobile'] = '?0';
    }

    if (referer) {
      fingerprint['Referer'] = referer;
    }

    return fingerprint;
  }

  /**
   * Registra um erro para um User-Agent.
   * Isso reduz a probabilidade de usá-lo novamente em seguida.
   */
  reportError(ua: string): void {
    const entry = this.entries.find((e) => e.ua === ua);
    if (entry) {
      entry.errorCount++;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Obtém estatísticas do pool para monitoramento.
   */
  getStats(): {
    total: number;
    totalUses: number;
    totalErrors: number;
    byBrowser: Record<string, { count: number; uses: number; errors: number }>;
    topUA: string;
    topUAUses: number;
  } {
    let totalUses = 0;
    let totalErrors = 0;
    const byBrowser: Record<string, { count: number; uses: number; errors: number }> = {};

    for (const e of this.entries) {
      totalUses += e.useCount;
      totalErrors += e.errorCount;

      if (!byBrowser[e.browser]) {
        byBrowser[e.browser] = { count: 0, uses: 0, errors: 0 };
      }
      byBrowser[e.browser]!.count++;
      byBrowser[e.browser]!.uses += e.useCount;
      byBrowser[e.browser]!.errors += e.errorCount;
    }

    // Top UA
    const sorted = [...this.entries].sort((a, b) => b.useCount - a.useCount);
    const top = sorted[0]!;

    return {
      total: this.entries.length,
      totalUses,
      totalErrors,
      byBrowser,
      topUA: top.ua.slice(0, 80) + '...',
      topUAUses: top.useCount,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const userAgentPool = new UserAgentPool();
