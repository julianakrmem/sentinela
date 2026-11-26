import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrend, linearSlope, median } from '../src/domain/trend.js';
import type { TrendSample } from '../src/domain/types.js';

const series = (n: number, f: (i: number) => Partial<TrendSample>, stepMs = 5_000): TrendSample[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: i * stepMs, news2: 0, hr: 75, spo2: 97, sbp: 125, rr: 15, temp: 36.7, ...f(i),
  }));

describe('utilitários estatísticos', () => {
  it('mediana', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
  it('inclinação de reta perfeita', () => {
    assert.equal(linearSlope([[0, 0], [1, 2], [2, 4]]), 2);
  });
});

describe('analyzeTrend', () => {
  it('poucos dados => insuficiente', () => {
    assert.equal(analyzeTrend(series(3, () => ({}))).status, 'insufficient');
  });

  it('paciente estável => estável', () => {
    const r = analyzeTrend(series(40, (i) => ({ news2: i % 2 })));
    assert.equal(r.status, 'stable');
  });

  it('NEWS2 subindo progressivamente => piora', () => {
    const r = analyzeTrend(series(40, (i) => ({ news2: Math.floor(i / 8) })));
    assert.equal(r.status, 'deteriorating');
    assert.ok(r.slopePer10Min! > 0);
    assert.match(r.reasons.join(' '), /NEWS2 subiu/);
  });

  it('queda de SpO2 sem mudança de escore ainda é piora', () => {
    const r = analyzeTrend(series(40, (i) => ({ spo2: 99 - Math.floor(i / 8) })));
    assert.equal(r.status, 'deteriorating');
    assert.match(r.reasons.join(' '), /SpO2 caiu/);
  });

  it('um único artefato no fim não vira tendência (mediana das 3 últimas)', () => {
    const r = analyzeTrend(series(40, (i) => (i === 39 ? { news2: 9, spo2: 60 } : {})));
    assert.equal(r.status, 'stable');
  });

  it('FC subindo isolada não basta; FC + FR juntas sim', () => {
    assert.equal(analyzeTrend(series(40, (i) => ({ hr: 75 + i }))).status, 'stable');
    assert.equal(analyzeTrend(series(40, (i) => ({ hr: 75 + i, rr: 15 + i / 4 }))).status, 'deteriorating');
  });

  it('NEWS2 caindo => melhora', () => {
    assert.equal(analyzeTrend(series(40, (i) => ({ news2: 6 - Math.floor(i / 7) }))).status, 'improving');
  });
});
