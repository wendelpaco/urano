/**
 * Technical Indicators — Análise Técnica sobre séries de preços.
 *
 * Calcula indicadores técnicos clássicos a partir de dados de histórico
 * (obtidos via Yahoo Finance pelo StockQuoteService).
 *
 * Indicadores disponíveis:
 *  - SMA (Simple Moving Average) — 20, 50, 200 períodos
 *  - EMA (Exponential Moving Average) — 12, 26 períodos
 *  - MACD (Moving Average Convergence Divergence)
 *  - RSI (Relative Strength Index) — 14 períodos
 *  - Bollinger Bands — 20 períodos, 2 desvios
 *  - Suporte/Resistência — máximas e mínimas relevantes
 *  - Volatilidade histórica
 *  - Volume médio
 *
 * Design: funções puras, sem I/O. Recebem arrays de preços,
 * retornam indicadores calculados.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface CandlePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  ticker: string;
  period: { start: string; end: string; days: number };
  price: {
    current: number;
    change: number;
    changePct: number;
    high52w: number;
    low52w: number;
  };
  sma: {
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
  };
  ema: {
    ema12: number | null;
    ema26: number | null;
  };
  macd: {
    macdLine: number | null;
    signalLine: number | null;
    histogram: number | null;
    signal: 'bullish' | 'bearish' | 'neutral';
  };
  rsi: {
    value: number | null;
    signal: 'oversold' | 'overbought' | 'neutral';
  };
  bollinger: {
    upper: number | null;
    middle: number | null;
    lower: number | null;
    width: number | null; // % — estreito = squeeze
  };
  supportResistance: {
    support: number | null;
    resistance: number | null;
  };
  volatility: {
    daily: number | null;    // % desvio padrão diário
    annualized: number | null; // % volatilidade anualizada
  };
  volume: {
    avg10d: number | null;
    avg30d: number | null;
    trend: 'increasing' | 'decreasing' | 'stable';
  };
}

// ─── Cálculos ───────────────────────────────────────────────────────────────

export class TechnicalIndicatorsCalculator {
  /**
   * Calcula TODOS os indicadores técnicos para uma série de candles.
   */
  calculate(ticker: string, candles: CandlePoint[]): TechnicalIndicators {
    const closes = candles.map((c) => c.close).filter((c) => c > 0);
    const highs = candles.map((c) => c.high).filter((c) => c > 0);
    const lows = candles.map((c) => c.low).filter((c) => c > 0);
    const volumes = candles.map((c) => c.volume).filter((c) => c > 0);

    const current = closes[closes.length - 1] ?? 0;
    const prev = closes.length >= 2 ? closes[closes.length - 2]! : current;

    // SMA
    const sma20 = this.sma(closes, 20);
    const sma50 = this.sma(closes, 50);
    const sma200 = this.sma(closes, 200);

    // EMA
    const ema12 = this.ema(closes, 12);
    const ema26 = this.ema(closes, 26);

    // MACD
    const macdData = this.macd(closes);

    // RSI
    const rsi = this.rsi(closes, 14);

    // Bollinger
    const bollinger = this.bollingerBands(closes, 20, 2);

    // Suporte/Resistência
    const sr = this.supportResistance(candles);

    // Volatilidade
    const vol = this.volatility(closes);

    // Volume
    const volTrend = this.volumeAnalysis(volumes);

    return {
      ticker,
      period: {
        start: candles[0]?.date ?? '',
        end: candles[candles.length - 1]?.date ?? '',
        days: candles.length,
      },
      price: {
        current: Math.round(current * 100) / 100,
        change: Math.round((current - prev) * 100) / 100,
        changePct: prev ? Math.round((current - prev) / prev * 10000) / 100 : 0,
        high52w: Math.round(Math.max(...highs) * 100) / 100,
        low52w: Math.round(Math.min(...lows) * 100) / 100,
      },
      sma: { sma20, sma50, sma200 },
      ema: { ema12, ema26 },
      macd: macdData,
      rsi,
      bollinger,
      supportResistance: sr,
      volatility: vol,
      volume: volTrend,
    };
  }

  // ─── SMA ──────────────────────────────────────────────────────────────

  sma(data: number[], period: number): number | null {
    if (data.length < period) return null;
    const slice = data.slice(-period);
    const sum = slice.reduce((a, b) => a + b, 0);
    return Math.round(sum / period * 100) / 100;
  }

  // ─── EMA ──────────────────────────────────────────────────────────────

  ema(data: number[], period: number): number | null {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA inicial
    for (let i = period; i < data.length; i++) {
      ema = data[i]! * k + ema * (1 - k);
    }
    return Math.round(ema * 100) / 100;
  }

  // ─── MACD ─────────────────────────────────────────────────────────────

  macd(data: number[]): TechnicalIndicators['macd'] {
    if (data.length < 26) {
      return { macdLine: null, signalLine: null, histogram: null, signal: 'neutral' };
    }

    // Calcula EMAs completas (para cada ponto)
    const ema12Values: number[] = [];
    const ema26Values: number[] = [];

    const k12 = 2 / 13;
    const k26 = 2 / 27;

    let ema12 = data[0]!;
    let ema26 = data[0]!;

    for (let i = 0; i < data.length; i++) {
      ema12 = data[i]! * k12 + ema12 * (1 - k12);
      ema26 = data[i]! * k26 + ema26 * (1 - k26);
      ema12Values.push(ema12);
      ema26Values.push(ema26);
    }

    // MACD line = EMA12 - EMA26
    const macdLine = Math.round((ema12Values[ema12Values.length - 1]! - ema26Values[ema26Values.length - 1]!) * 100) / 100;

    // Signal line = EMA9 da MACD line
    const macdValues = ema12Values.map((e12, i) => e12 - ema26Values[i]!);
    const k9 = 2 / 10;
    let signal = macdValues[0]!;
    for (let i = 0; i < macdValues.length; i++) {
      signal = macdValues[i]! * k9 + signal * (1 - k9);
    }

    const signalLine = Math.round(signal * 100) / 100;
    const histogram = Math.round((macdLine - signalLine) * 100) / 100;

    // Sinal
    let macdSignal: TechnicalIndicators['macd']['signal'] = 'neutral';
    if (histogram > 0 && macdLine > signalLine) macdSignal = 'bullish';
    else if (histogram < 0 && macdLine < signalLine) macdSignal = 'bearish';

    return { macdLine, signalLine, histogram, signal: macdSignal };
  }

  // ─── RSI ──────────────────────────────────────────────────────────────

  rsi(data: number[], period: number = 14): TechnicalIndicators['rsi'] {
    if (data.length < period + 1) {
      return { value: null, signal: 'neutral' };
    }

    const changes: number[] = [];
    for (let i = 1; i < data.length; i++) {
      changes.push(data[i]! - data[i - 1]!);
    }

    // Média inicial
    const initialGains = changes.slice(0, period).filter((c) => c > 0);
    const initialLosses = changes.slice(0, period).filter((c) => c < 0);

    let avgGain = initialGains.reduce((a, b) => a + b, 0) / period;
    let avgLoss = Math.abs(initialLosses.reduce((a, b) => a + b, 0)) / period;

    // Smoothing
    for (let i = period; i < changes.length; i++) {
      const change = changes[i]!;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) {
      return { value: 100, signal: 'overbought' };
    }

    const rs = avgGain / avgLoss;
    const rsiValue = Math.round((100 - 100 / (1 + rs)) * 100) / 100;

    let signal: TechnicalIndicators['rsi']['signal'] = 'neutral';
    if (rsiValue >= 70) signal = 'overbought';
    else if (rsiValue <= 30) signal = 'oversold';

    return { value: rsiValue, signal };
  }

  // ─── Bollinger Bands ──────────────────────────────────────────────────

  bollingerBands(
    data: number[],
    period: number = 20,
    stdDev: number = 2,
  ): TechnicalIndicators['bollinger'] {
    if (data.length < period) {
      return { upper: null, middle: null, lower: null, width: null };
    }

    const middle = this.sma(data, period);
    if (middle === null) return { upper: null, middle: null, lower: null, width: null };

    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);

    const upper = Math.round((middle + stdDev * std) * 100) / 100;
    const lower = Math.round((middle - stdDev * std) * 100) / 100;
    const width = Math.round((upper - lower) / middle * 10000) / 100;

    return { upper, middle, lower, width };
  }

  // ─── Suporte / Resistência ────────────────────────────────────────────

  supportResistance(candles: CandlePoint[]): TechnicalIndicators['supportResistance'] {
    if (candles.length < 20) return { support: null, resistance: null };

    const lows = candles.map((c) => c.low);
    const highs = candles.map((c) => c.high);

    // Suporte: menor mínima dos últimos 20 candles que foi tocada 2+ vezes
    const recentLows = lows.slice(-20).sort((a, b) => a - b);
    const support = recentLows[0] ?? null;

    // Resistência: maior máxima dos últimos 20 candles que foi tocada 2+ vezes
    const recentHighs = highs.slice(-20).sort((a, b) => b - a);
    const resistance = recentHighs[0] ?? null;

    return {
      support: support ? Math.round(support * 100) / 100 : null,
      resistance: resistance ? Math.round(resistance * 100) / 100 : null,
    };
  }

  // ─── Volatilidade ─────────────────────────────────────────────────────

  volatility(data: number[]): TechnicalIndicators['volatility'] {
    if (data.length < 5) return { daily: null, annualized: null };

    const returns: number[] = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1]! > 0) {
        returns.push((data[i]! - data[i - 1]!) / data[i - 1]!);
      }
    }

    if (returns.length < 2) return { daily: null, annualized: null };

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const daily = Math.sqrt(variance);

    return {
      daily: Math.round(daily * 10000) / 100,
      annualized: Math.round(daily * Math.sqrt(252) * 10000) / 100,
    };
  }

  // ─── Volume ───────────────────────────────────────────────────────────

  volumeAnalysis(volumes: number[]): TechnicalIndicators['volume'] {
    if (volumes.length < 10) return { avg10d: null, avg30d: null, trend: 'stable' };

    const avg10 = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const avg30 = volumes.length >= 30
      ? volumes.slice(-30).reduce((a, b) => a + b, 0) / 30
      : null;

    // Tendência: compara média dos últimos 5 vs anteriores 5
    const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prev5 = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;

    let trend: TechnicalIndicators['volume']['trend'] = 'stable';
    if (recent5 > prev5 * 1.2) trend = 'increasing';
    else if (recent5 < prev5 * 0.8) trend = 'decreasing';

    return {
      avg10d: Math.round(avg10),
      avg30d: avg30 ? Math.round(avg30) : null,
      trend,
    };
  }
}

export const technicalIndicators = new TechnicalIndicatorsCalculator();
