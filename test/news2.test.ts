import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNews2, scorePulse, scoreRespiration, scoreSpo2Scale1, scoreSpo2Scale2, scoreSystolic, scoreTemperature,
} from '../src/domain/news2.js';
import type { VitalSigns } from '../src/domain/types.js';

const normal: Omit<VitalSigns, 'bedId' | 'ts'> = {
  hr: 72, spo2: 98, sbp: 125, rr: 15, temp: 36.8, consciousness: 'A', onOxygen: false, spo2Scale: 1,
};

describe('NEWS2 — faixas por parâmetro (limites exatos da tabela RCP 2017)', () => {
  const cases: Array<[string, (v: number) => number, Array<[number, number]>]> = [
    ['frequência respiratória', scoreRespiration, [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3]]],
    ['SpO2 escala 1', scoreSpo2Scale1, [[91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0]]],
    ['PAS', scoreSystolic, [[90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3]]],
    ['FC', scorePulse, [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]]],
    ['temperatura', scoreTemperature, [[35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2]]],
  ];
  for (const [name, fn, table] of cases) {
    it(name, () => {
      for (const [value, expected] of table) assert.equal(fn(value), expected, `${name}=${value}`);
    });
  }

  it('SpO2 escala 2 só pontua saturação alta quando em O2', () => {
    for (const [s, o2, e] of [[83, false, 3], [84, false, 2], [86, false, 1], [88, false, 0], [92, true, 0],
      [93, false, 0], [97, false, 0], [93, true, 1], [95, true, 2], [97, true, 3]] as const) {
      assert.equal(scoreSpo2Scale2(s, o2), e, `spo2=${s} o2=${o2}`);
    }
  });
});

describe('NEWS2 — agregado e risco clínico', () => {
  it('paciente normal = 0, risco baixo', () => {
    const r = computeNews2(normal);
    assert.equal(r.total, 0);
    assert.equal(r.risk, 'low');
    assert.equal(r.redScore, false);
  });

  it('um parâmetro com 3 pontos isolado = risco baixo-médio', () => {
    const r = computeNews2({ ...normal, consciousness: 'C' });
    assert.equal(r.total, 3);
    assert.equal(r.redScore, true);
    assert.equal(r.risk, 'low-medium');
  });

  it('5–6 pontos = risco médio', () => {
    const r = computeNews2({ ...normal, rr: 22, hr: 115, temp: 38.5 }); // 2 + 2 + 1
    assert.equal(r.total, 5);
    assert.equal(r.risk, 'medium');
  });

  it('≥ 7 pontos = risco alto (quadro séptico)', () => {
    const r = computeNews2({ ...normal, rr: 26, hr: 125, sbp: 95, temp: 39.4, spo2: 93 });
    // FR 3 + FC 2 + PAS 2 + Temp 2 + SpO2 2 = 11
    assert.equal(r.total, 11);
    assert.equal(r.risk, 'high');
    assert.match(r.recommendation, /emergência/);
  });

  it('O2 suplementar soma 2 pontos', () => {
    assert.equal(computeNews2({ ...normal, onOxygen: true }).subscores.oxygen, 2);
  });

  it('DPOC na escala 2 com SpO2 90% em O2 não pontua saturação', () => {
    const r = computeNews2({ ...normal, spo2: 90, spo2Scale: 2, onOxygen: true });
    assert.equal(r.subscores.spo2, 0);
    assert.equal(r.total, 2);
  });
});
