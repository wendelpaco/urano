import { describe, it, expect } from 'bun:test';
import { buildSectorPeerSummary } from '../../src/core/services/sector-peers.ts';
import { stanceFromScore } from '../../src/core/services/investment-guidance.ts';

describe('buildSectorPeerSummary', () => {
  const self = {
    ticker: 'WEGE3',
    name: 'WEG',
    peRatio: 25,
    pbRatio: 8,
    roe: 28,
    dividendYield: 1.5,
    netMargin: 18,
    debtToEquity: 0.2,
    score: 80,
  };

  const peers = [
    {
      ticker: 'ITUB4',
      peRatio: 8,
      pbRatio: 1.5,
      roe: 18,
      dividendYield: 6,
      netMargin: 20,
      debtToEquity: 4,
      score: 70,
    },
    {
      ticker: 'BBDC4',
      peRatio: 7,
      pbRatio: 1.2,
      roe: 14,
      dividendYield: 5,
      netMargin: 15,
      debtToEquity: 5,
      score: 65,
    },
    {
      ticker: 'SANB11',
      peRatio: 9,
      pbRatio: 1.4,
      roe: 16,
      dividendYield: 5.5,
      netMargin: 17,
      debtToEquity: 4.5,
      score: 68,
    },
  ];

  it('calcula mediana e peers ordenados por score', () => {
    const s = buildSectorPeerSummary(self, 'Bens industriais', peers);
    expect(s.peerCount).toBe(3);
    expect(s.medians.roe).not.toBeNull();
    expect(s.peers[0]?.ticker).toBe('ITUB4'); // maior score entre peers
    expect(s.vsSector.some((v) => v.field === 'roe')).toBe(true);
    expect(s.summary.length).toBeGreaterThan(20);
  });

  it('sem peers → mensagem de amostra insuficiente', () => {
    const s = buildSectorPeerSummary(self, 'Nicho', []);
    expect(s.peerCount).toBe(0);
    expect(s.summary).toMatch(/peers|Comparador/i);
  });

  it('exclui o próprio ticker da lista de peers', () => {
    const s = buildSectorPeerSummary(self, 'Indústria', [
      self,
      { ticker: 'RAIL3', score: 60, roe: 10, peRatio: 12, pbRatio: 2, dividendYield: 2, netMargin: 8, debtToEquity: 1 },
    ]);
    expect(s.peers.every((p) => p.ticker !== 'WEGE3')).toBe(true);
    expect(s.peerCount).toBe(1);
  });
});

describe('stanceFromScore', () => {
  it('score alto → postura positiva', () => {
    const s = stanceFromScore(80);
    expect(['accumulate', 'study_to_buy']).toContain(s.stance);
    expect(s.stanceLabel.length).toBeGreaterThan(5);
  });

  it('score baixo → avoid ou reduce', () => {
    const s = stanceFromScore(25);
    expect(['avoid_entry', 'consider_reduce']).toContain(s.stance);
    expect(s.stanceTone).toBe('negative');
  });
});
