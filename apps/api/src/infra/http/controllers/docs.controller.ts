/**
 * Urano API — OpenAPI 3.0 Specification
 *
 * API de análise fundamentalista de ações e FIIs brasileiros.
 * Scores, ranking, screener, alocação de carteiras e dados macroeconômicos.
 * Dados oficiais: B3, CVM, BCB, Yahoo Finance.
 *
 * Servido em: GET /v1/docs/openapi.json
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Urano API',
    version: '1.0.0',
    description:
      'API de análise fundamentalista do mercado brasileiro. Scores 0-100 para ações e FIIs, ' +
      'ranking, screener com 15 filtros, alocação de carteiras, cotações, proventos e dados macroeconômicos. ' +
      'Dados oficiais da B3, CVM e BCB. ' +
      'Correlação: envie ou receba `x-request-id` em todas as respostas. ' +
      'Segurança: `x-api-key` (hash SHA-256 no banco), rate limit por key, headers ' +
      '(X-Content-Type-Options, X-Frame-Options, Cache-Control: no-store em rotas autenticadas).',
    contact: { name: 'Urano', url: 'https://github.com/urano' },
  },
  servers: [
    { url: 'http://localhost:3000/v1', description: 'Desenvolvimento local' },
    { url: 'https://api.urano.app/v1', description: 'Produção' },
  ],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API Key gerada via POST /keys ou bun run key:create',
      },
    },
    parameters: {
      RequestId: {
        name: 'x-request-id',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'ID de correlação opcional; se omitido, a API gera um UUID e ecoa em x-request-id na resposta.',
      },
    },
  },
  paths: {
    '/healthcheck': {
      get: {
        tags: ['Sistema'],
        summary: 'Health check',
        description: 'Verifica disponibilidade do serviço (rota pública, sem auth).',
        security: [],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/metrics': {
      get: {
        tags: ['Sistema'],
        summary: 'Métricas de processo (JSON)',
        description:
          'Snapshot de uptime e memória do processo. Não é Prometheus exposition. ' +
          'Requer x-api-key com escopo admin:ops (ou *). Correlação via x-request-id.',
        parameters: [{ $ref: '#/components/parameters/RequestId' }],
        responses: {
          '200': {
            description:
              'JSON: { uptimeSeconds, memory: { rss, heapUsed }, nodeEnv }',
          },
          '401': { description: 'Sem x-api-key ou key inválida' },
          '403': { description: 'Sem escopo admin:ops' },
        },
      },
    },

    // ── Companies ────────────────────────────────────────────────────────
    '/companies': {
      get: {
        tags: ['Empresas'],
        summary: 'Listar empresas',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Busca por nome' },
          { name: 'sector', in: 'query', schema: { type: 'string' }, description: 'Filtrar por setor' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { '200': { description: 'Lista de empresas' } },
      },
    },
    '/companies/sectors': {
      get: { tags: ['Empresas'], summary: 'Listar setores', responses: { '200': { description: 'Setores' } } },
    },
    '/companies/{ticker}': {
      get: {
        tags: ['Empresas'], summary: 'Detalhes da empresa',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'PETR4' }],
        responses: { '200': { description: 'Empresa' }, '404': { description: 'Não encontrada' } },
      },
    },

    // ── Fundamentals ─────────────────────────────────────────────────────
    '/fundamentals/{ticker}': {
      get: {
        tags: ['Fundamentos'], summary: 'Indicadores fundamentalistas (27+)',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'PETR4' }],
        responses: { '200': { description: 'Indicadores TTM' }, '404': { description: 'Sem fundamentos' } },
      },
    },
    '/fundamentals/{ticker}/history': {
      get: {
        tags: ['Fundamentos'], summary: 'Histórico de fundamentos',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 40 }, description: 'Trimestres (1-80)' },
        ],
        responses: { '200': { description: 'Série histórica' } },
      },
    },

    // ── Stocks ───────────────────────────────────────────────────────────
    '/stocks/{ticker}/quote': {
      get: {
        tags: ['Ações'], summary: 'Cotação em tempo real',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Cotação' }, '502': { description: 'Indisponível' } },
      },
    },
    '/stocks/{ticker}/history': {
      get: {
        tags: ['Ações'], summary: 'Histórico de preços OHLCV',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'range', in: 'query', schema: { type: 'string', enum: ['1mo', '3mo', '6mo', '1y', '2y', '5y'], default: '1mo' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        ],
        responses: { '200': { description: 'Histórico' } },
      },
    },
    '/stocks/{ticker}/stats': {
      get: {
        tags: ['Ações'], summary: 'Estatísticas (52w, YTD, volume)',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Estatísticas' } },
      },
    },
    '/stocks/{ticker}/corporate-events': {
      get: {
        tags: ['Ações'], summary: 'Eventos corporativos (splits, grupamentos)',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'year', in: 'query', schema: { type: 'integer' }, description: 'Filtrar por ano' },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        ],
        responses: { '200': { description: 'Eventos' } },
      },
    },
    '/stocks/{ticker}/indicators': {
      get: {
        tags: ['Ações'], summary: 'Indicadores técnicos (SMA, RSI, MACD, etc.)',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'PETR4' }],
        responses: {
          '200': { description: 'Indicadores técnicos calculados sobre ~1y de preços' },
          '404': { description: 'Dados insuficientes (< 20 pontos)' },
          '502': { description: 'Indisponível' },
        },
      },
    },
    '/stocks/quotes': {
      get: {
        tags: ['Ações'], summary: 'Cotações em lote (até 20)',
        parameters: [{ name: 'tickers', in: 'query', required: true, schema: { type: 'string' }, description: 'PETR4,VALE3,ITUB4' }],
        responses: { '200': { description: 'Lista de cotações' } },
      },
    },

    // ── Dividends ────────────────────────────────────────────────────────
    '/dividends/{ticker}': {
      get: {
        tags: ['Proventos'], summary: 'Histórico de proventos + análise',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'BBAS3' }],
        responses: { '200': { description: 'Proventos com análise de estabilidade, consistência e tendência' } },
      },
    },

    // ── FIIs ─────────────────────────────────────────────────────────────
    '/fiis': {
      get: {
        tags: ['FIIs'], summary: 'Listar FIIs com cotação',
        parameters: [
          { name: 'segment', in: 'query', schema: { type: 'string' } },
          { name: 'withQuote', in: 'query', schema: { type: 'boolean', default: true } },
        ],
        responses: { '200': { description: 'Lista de FIIs' } },
      },
    },
    '/fiis/screener': {
      get: {
        tags: ['FIIs'], summary: 'Screener de FIIs',
        parameters: [
          { name: 'pvp_lte', in: 'query', schema: { type: 'number' }, description: 'P/VP máximo (ex: 1.0)' },
          { name: 'pvp_gte', in: 'query', schema: { type: 'number' }, description: 'P/VP mínimo' },
          { name: 'dy_gte', in: 'query', schema: { type: 'number' }, description: 'DY mínimo % a.a. (ex: 8)' },
          { name: 'dy_lte', in: 'query', schema: { type: 'number' }, description: 'DY máximo % a.a.' },
          { name: 'liquidity_gte', in: 'query', schema: { type: 'number' }, description: 'Liquidez mínima (R$)' },
          { name: 'classification', in: 'query', schema: { type: 'string', enum: ['tijolo', 'papel', 'hibrido', 'fundo_de_fundos'] } },
          { name: 'segment', in: 'query', schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['dy', 'pvp', 'price', 'liquidity'], default: 'dy' } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Resultados do screener' } },
      },
    },
    '/fiis/{ticker}': {
      get: {
        tags: ['FIIs'], summary: 'Detalhes do FII',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'HGLG11' }],
        responses: { '200': { description: 'FII' } },
      },
    },
    '/fiis/{ticker}/history': {
      get: {
        tags: ['FIIs'], summary: 'Histórico de preços do FII',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'range', in: 'query', schema: { type: 'string', enum: ['1mo', '3mo', '6mo', '1y', '2y', '5y'], default: '1y' } },
        ],
        responses: { '200': { description: 'Histórico' } },
      },
    },
    '/fiis/{ticker}/operational': {
      get: {
        tags: ['FIIs'], summary: 'Dados operacionais (vacância, imóveis, inquilinos)',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Dados operacionais' } },
      },
    },
    '/fiis/{ticker}/cvm': {
      get: {
        tags: ['FIIs'],
        summary: 'Informe mensal CVM (NAV, PL, cotas)',
        description:
          'Dados oficiais open data CVM (fii_cvm_monthly). Preferir a scrape de P/VP comercial. ' +
          'Requer escopo read:market.',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'HGLG11' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 12, maximum: 60 } },
        ],
        responses: {
          '200': { description: 'Série mensal CVM + latest' },
          '404': { description: 'Sem dados CVM para o ticker (rode worker:fii-cvm + worker:fii-link)' },
        },
      },
    },
    '/fiis/{ticker}/total-return': {
      get: {
        tags: ['FIIs'],
        summary: 'Total return (cota Yahoo + proventos)',
        description:
          'Retorno total real: variação de preço + soma de proventos no período. Fontes free (Yahoo + dividend_events/StatusInvest).',
        parameters: [
          { name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'HGLG11' },
          {
            name: 'range',
            in: 'query',
            schema: { type: 'string', enum: ['1y', '2y', '3y', '5y'], default: '1y' },
          },
        ],
        responses: { '200': { description: 'Total return, price return, yield contribution' } },
      },
    },

    // ── Benchmarks ───────────────────────────────────────────────────────
    '/benchmarks': {
      get: {
        tags: ['Benchmarks'],
        summary: 'Listar benchmarks free (IBOV, IFIX experimental)',
        description: 'Metadados de séries de benchmark (Yahoo). Escopo read:market.',
        responses: { '200': { description: 'Lista de benchmarks disponíveis' } },
      },
    },
    '/benchmarks/{id}': {
      get: {
        tags: ['Benchmarks'],
        summary: 'Série de retornos do benchmark',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['ibov', 'ifix'] },
            example: 'ibov',
          },
          {
            name: 'years',
            in: 'query',
            schema: { type: 'integer', default: 10, minimum: 1, maximum: 20 },
          },
        ],
        responses: {
          '200': { description: 'Retornos anuais + source/asOf' },
          '404': { description: 'Benchmark desconhecido' },
        },
      },
    },

    // ── Search ───────────────────────────────────────────────────────────
    '/search': {
      get: {
        tags: ['Análise'], summary: 'Buscar ativos por ticker ou nome',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 50 }, example: 'PETR' },
        ],
        responses: { '200': { description: 'Resultados da busca (pode disparar scrape em background se ticker desconhecido)' }, '400': { description: 'Query inválida' } },
      },
    },

    // ── Analysis ─────────────────────────────────────────────────────────
    '/analysis/stocks/{ticker}': {
      get: {
        tags: ['Análise'],
        summary: 'Score de qualidade fundamentalista da ação (0-100)',
        description:
          'Score é um filtro de qualidade fundamentalista (screen de fundamentos), não um preditor de retornos em excesso.',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'PETR4' }],
        responses: { '200': { description: 'Score com breakdown, reasons, alerts e indicadores' }, '404': { description: 'Não encontrado' } },
      },
    },
    '/analysis/fiis/{ticker}': {
      get: {
        tags: ['Análise'],
        summary: 'Score de qualidade fundamentalista do FII (0-100)',
        description:
          'Score é um filtro de qualidade fundamentalista (screen de fundamentos), não um preditor de retornos em excesso.',
        parameters: [{ name: 'ticker', in: 'path', required: true, schema: { type: 'string' }, example: 'HGLG11' }],
        responses: { '200': { description: 'Score FII com classificação e recomendação' }, '404': { description: 'Não encontrado' } },
      },
    },
    '/analysis/ranking': {
      get: {
        tags: ['Análise'],
        summary: 'Ranking por score de qualidade',
        description:
          'Ordena ativos pelo score de qualidade fundamentalista (filtro de qualidade, não preditor de excess returns).',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['stock', 'fii'], default: 'stock' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, minimum: 1, maximum: 500 } },
          {
            name: 'minScore', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100 },
            description: 'Filtro de qualidade mínima (0-100); não implica expectativa de retorno',
          },
          { name: 'sort', in: 'query', schema: { type: 'string', default: 'score' }, description: 'Campo numérico ou ticker' },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
        ],
        responses: { '200': { description: 'Ranking' }, '400': { description: 'Query inválida' } },
      },
    },
    '/analysis/allocate': {
      post: {
        tags: ['Análise'],
        summary: 'Sugerir alocação de carteira',
        description:
          'Monta carteira por perfil de risco entre ativos que passam no filtro de qualidade (score). Score não prediz excess returns.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  totalAmount: { type: 'number', default: 10000 },
                  riskProfile: { type: 'string', enum: ['conservador', 'moderado', 'agressivo'], default: 'moderado' },
                  stockPercent: { type: 'number' },
                  fiiPercent: { type: 'number' },
                  minScore: {
                    type: 'number',
                    description: 'Filtro de qualidade mínima (0-100); não prediz retorno em excesso',
                  },
                  maxAssets: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Carteira sugerida' }, '400': { description: 'Payload inválido' } },
      },
    },
    '/analysis/compare': {
      post: {
        tags: ['Análise'], summary: 'Comparar ações ou FIIs lado a lado',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tickers'],
                properties: {
                  tickers: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, example: ['PETR4', 'VALE3'] },
                  type: { type: 'string', enum: ['stock', 'fii'], default: 'stock' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Comparação com bestPick e avgScore' }, '400': { description: 'Payload inválido' } },
      },
    },
    '/analysis/contribution': {
      post: {
        tags: ['Análise'],
        summary: 'Sugerir aporte (contribution advisor)',
        description:
          'Sugere onde alocar um aporte dado o perfil e posições atuais, usando score como filtro de qualidade fundamentalista (não preditor de excess returns).',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                properties: {
                  amount: { type: 'number', description: 'Valor do aporte (R$)' },
                  profile: { type: 'string', enum: ['conservador', 'moderado', 'agressivo'], default: 'moderado' },
                  positions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        ticker: { type: 'string' },
                        quantity: { type: 'number' },
                      },
                    },
                    default: [],
                  },
                  onlyTypes: { type: 'array', items: { type: 'string', enum: ['stock', 'fii'] } },
                  excludeSectors: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Sugestão de aporte com warnings de data health' }, '400': { description: 'Payload inválido' } },
      },
    },
    '/analysis/validation': {
      get: {
        tags: ['Análise'],
        summary: 'Metadados de validação do score',
        description:
          'Dados de validação/limites do score como filtro de qualidade (não como preditor de retornos).',
        responses: { '200': { description: 'Resultados de validação do score' } },
      },
    },

    // ── Screener ─────────────────────────────────────────────────────────
    '/screener': {
      get: {
        tags: ['Screener'], summary: 'Filtrar ações por 15 indicadores',
        parameters: [
          {
            name: 'minScore', in: 'query', schema: { type: 'integer' },
            description: 'Filtro de qualidade mínima (score); não implica expectativa de retorno',
          },
          { name: 'maxScore', in: 'query', schema: { type: 'integer' } },
          { name: 'minPE', in: 'query', schema: { type: 'number' } },
          { name: 'maxPE', in: 'query', schema: { type: 'number' } },
          { name: 'minPVP', in: 'query', schema: { type: 'number' } },
          { name: 'maxPVP', in: 'query', schema: { type: 'number' } },
          { name: 'minEVEBIT', in: 'query', schema: { type: 'number' } },
          { name: 'maxEVEBIT', in: 'query', schema: { type: 'number' } },
          { name: 'minROE', in: 'query', schema: { type: 'number' } },
          { name: 'maxROE', in: 'query', schema: { type: 'number' } },
          { name: 'minROA', in: 'query', schema: { type: 'number' } },
          { name: 'maxROA', in: 'query', schema: { type: 'number' } },
          { name: 'minDY', in: 'query', schema: { type: 'number' } },
          { name: 'maxDE', in: 'query', schema: { type: 'number' } },
          { name: 'minNetMargin', in: 'query', schema: { type: 'number' } },
          { name: 'sector', in: 'query', schema: { type: 'string' } },
          { name: 'year', in: 'query', schema: { type: 'integer' } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['score', 'peRatio', 'pvp', 'roe', 'roa', 'dy', 'netMargin', 'ticker'] } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Resultados do screener' } },
      },
    },

    // ── Macro ────────────────────────────────────────────────────────────
    '/macro': {
      get: {
        tags: ['Macro'], summary: 'Listar indicadores disponíveis',
        responses: { '200': { description: 'Séries: selic, ipca, cdi, usd_brl' } },
      },
    },
    '/macro/{series}': {
      get: {
        tags: ['Macro'], summary: 'Dados da série macroeconômica',
        parameters: [
          { name: 'series', in: 'path', required: true, schema: { type: 'string' }, example: 'selic' },
          { name: 'start', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD' },
          { name: 'end', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 252 } },
        ],
        responses: { '200': { description: 'Série temporal' } },
      },
    },

    // ── Wallets ──────────────────────────────────────────────────────────
    '/wallets': {
      get: { tags: ['Carteiras'], summary: 'Listar carteiras da API key', responses: { '200': { description: 'Carteiras' } } },
      post: {
        tags: ['Carteiras'], summary: 'Criar carteira',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
              },
            },
          },
        },
        responses: { '201': { description: 'Criada' }, '400': { description: 'Payload inválido' } },
      },
    },
    '/wallets/{walletId}': {
      get: {
        tags: ['Carteiras'], summary: 'Detalhes da carteira com ativos',
        parameters: [{ name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Carteira + assets' }, '404': { description: 'Não encontrada' } },
      },
      put: {
        tags: ['Carteiras'], summary: 'Atualizar carteira',
        parameters: [{ name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } },
            },
          },
        },
        responses: { '200': { description: 'Atualizada' }, '400': { description: 'Payload inválido' }, '404': { description: 'Não encontrada' } },
      },
      delete: {
        tags: ['Carteiras'], summary: 'Remover carteira',
        parameters: [{ name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Removida' }, '404': { description: 'Não encontrada' } },
      },
    },
    '/wallets/{walletId}/assets': {
      post: {
        tags: ['Carteiras'], summary: 'Adicionar ou atualizar ativo na carteira',
        parameters: [{ name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ticker', 'targetAllocationPercent'],
                properties: {
                  ticker: { type: 'string', example: 'PETR4' },
                  targetAllocationPercent: { type: 'number', minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Ativo adicionado/atualizado' }, '400': { description: 'Payload inválido' }, '404': { description: 'Carteira não encontrada' } },
      },
    },
    '/wallets/{walletId}/assets/{assetId}': {
      delete: {
        tags: ['Carteiras'], summary: 'Remover ativo da carteira',
        parameters: [
          { name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'assetId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Ativo removido' }, '404': { description: 'Carteira ou ativo não encontrado' } },
      },
    },
    '/wallets/{walletId}/rebalance': {
      post: {
        tags: ['Carteiras'], summary: 'Calcular rebalanceamento',
        parameters: [{ name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['availableAmount'],
                properties: {
                  availableAmount: { type: 'number' },
                  currentPositions: {
                    type: 'array',
                    items: { type: 'object', properties: { ticker: { type: 'string' }, quantity: { type: 'number' } } },
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Sugestões de compra/venda' }, '404': { description: 'Carteira não encontrada' } },
      },
    },

    // ── Auth ─────────────────────────────────────────────────────────────
    '/keys': {
      get: {
        tags: ['Auth'],
        summary: 'Listar API keys do dono',
        description: 'Requer escopo admin:keys (ou *). Keys filhas listam só as próprias.',
        responses: { '200': { description: 'Chaves (sem segredo; só prefix/scopes/meta)' } },
      },
      post: {
        tags: ['Auth'],
        summary: 'Criar API key filha',
        description:
          'Escopos: read:market, write:wallet, admin:keys, admin:ops, * (full). ' +
          'Default de filhas: [read:market, write:wallet]. Segredo exibido uma vez.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  scopes: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['read:market', 'write:wallet', 'admin:keys', 'admin:ops', '*'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Chave criada (segredo exibido uma única vez)' },
          '400': { description: 'Payload inválido' },
          '403': { description: 'Sem escopo admin:keys' },
        },
      },
    },
    '/keys/{id}/rotate': {
      post: {
        tags: ['Auth'],
        summary: 'Rotacionar API key',
        description: 'Requer admin:keys. Gera novo segredo; id estável.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Nova chave' },
          '403': { description: 'Sem escopo ou ownership' },
          '404': { description: 'Não encontrada' },
        },
      },
    },
    '/keys/{id}': {
      delete: {
        tags: ['Auth'],
        summary: 'Desativar API key',
        description: 'Requer admin:keys. Soft-delete / deactivate.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Desativada' },
          '403': { description: 'Sem escopo ou ownership' },
          '404': { description: 'Não encontrada' },
        },
      },
    },

    // ── Health & diagnostics ─────────────────────────────────────────────
    '/health/data': {
      get: {
        tags: ['Sistema'],
        summary: 'Saúde dos dados (cobertura, freshness)',
        description: 'Escopo read:market. Usado por contribution/UI para warnings.',
        responses: { '200': { description: 'Métricas de data health + warnings' } },
      },
    },
    '/health/scraper': {
      get: {
        tags: ['Sistema'],
        summary: 'Diagnóstico do scraper (jobs, circuit breakers, rate limiters)',
        description: 'Escopo admin:ops. Internals de pipeline, não produto.',
        responses: {
          '200': { description: 'Status operacional do pipeline de scraping' },
          '403': { description: 'Sem escopo admin:ops' },
        },
      },
    },
    // /metrics já documentado no topo com admin:ops implícito no description

    // ── Docs ─────────────────────────────────────────────────────────────
    '/docs/openapi.json': {
      get: {
        tags: ['Sistema'], summary: 'Especificação OpenAPI 3.0',
        responses: { '200': { description: 'OpenAPI JSON' } },
      },
    },
  },
};

/** GET /v1/docs/openapi.json */
export async function openApiController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.send(spec);
}
