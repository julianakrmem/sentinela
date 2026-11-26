import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY_CONFIG, evaluate, initialBedState, targetPriority } from '../src/domain/alert-policy.js';
import { computeNews2 } from '../src/domain/news2.js';
import type { BedState, TrendResult, VitalSigns } from '../src/domain/types.js';

const base: Omit<VitalSigns, 'bedId' | 'ts'> = {
  hr: 72, spo2: 98, sbp: 125, rr: 15, temp: 36.8, consciousness: 'A', onOxygen: false, spo2Scale: 1,
};
const critical = computeNews2({ ...base, rr: 26, hr: 125, sbp: 95, temp: 39.4 }); // 9
const medium = computeNews2({ ...base, rr: 22, hr: 115, temp: 38.5 }); // 5
const normal = computeNews2(base);
const worsening: TrendResult = { status: 'deteriorating', samples: 20, spanMs: 120_000, reasons: ['NEWS2 subiu de 1 para 4 em 2 min'] };

let n = 0;
const id = () => `a${++n}`;
const cfg = DEFAULT_POLICY_CONFIG;

function run(steps: Array<{ t: number; news2: typeof normal; trend?: TrendResult }>, start?: BedState) {
  let state = start ?? initialBedState('B1', 0);
  const alerts = [];
  for (const s of steps) {
    const out = evaluate(state, { bedId: 'B1', now: s.t, news2: s.news2, trend: s.trend }, cfg, id);
    state = out.state;
    alerts.push(...out.alerts);
  }
  return { state, alerts };
}

describe('targetPriority', () => {
  it('mapeia risco NEWS2 para prioridade', () => {
    assert.equal(targetPriority(normal), 'NONE');
    assert.equal(targetPriority(computeNews2({ ...base, consciousness: 'V' })), 'MEDIUM');
    assert.equal(targetPriority(medium), 'HIGH');
    assert.equal(targetPriority(critical), 'CRITICAL');
  });
  it('tendência de piora sobe um degrau, com teto em HIGH', () => {
    assert.equal(targetPriority(normal, worsening), 'MEDIUM');
    assert.equal(targetPriority(medium, worsening), 'HIGH');
    assert.equal(targetPriority(critical, worsening), 'CRITICAL');
  });
});

describe('evaluate — escalonamento', () => {
  it('leitura crítica isolada (artefato) NÃO alerta', () => {
    const { alerts, state } = run([
      { t: 1000, news2: normal }, { t: 2000, news2: critical }, { t: 3000, news2: normal },
    ]);
    assert.equal(alerts.length, 0);
    assert.equal(state.level, 'NONE');
  });

  it('duas leituras críticas consecutivas => alerta CRÍTICO', () => {
    const { alerts, state } = run([{ t: 1000, news2: critical }, { t: 2000, news2: critical }]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'ESCALATION');
    assert.equal(alerts[0]!.priority, 'CRITICAL');
    assert.equal(state.level, 'CRITICAL');
  });

  it('confirmação escala para o menor nível confirmado', () => {
    const { alerts } = run([{ t: 1000, news2: critical }, { t: 2000, news2: medium }]);
    assert.equal(alerts[0]!.priority, 'HIGH');
  });

  it('tendência de piora gera alerta MÉDIO mesmo com escore baixo', () => {
    const { alerts } = run([{ t: 1, news2: normal, trend: worsening }, { t: 2, news2: normal, trend: worsening }]);
    assert.equal(alerts[0]!.priority, 'MEDIUM');
    assert.ok(alerts[0]!.reasons.some((r) => r.includes('NEWS2 subiu')));
  });
});

describe('evaluate — lembretes e reconhecimento', () => {
  const escalated = run([{ t: 0, news2: critical }, { t: 1000, news2: critical }]).state;

  it('sem ack: lembrete após renotify', () => {
    const { alerts } = run([
      { t: 30_000, news2: critical }, { t: 1000 + cfg.renotifyMs.CRITICAL, news2: critical },
    ], escalated);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'REMINDER');
    assert.equal(alerts[0]!.id, escalated.activeAlertId, 'lembrete pertence ao mesmo episódio');
  });

  it('com ack: silencia até o fim do snooze', () => {
    const acked = { ...escalated, acknowledgedAt: 2000, acknowledgedBy: 'Enf. Teste' };
    const quiet = run([{ t: 2000 + cfg.renotifyMs.CRITICAL * 2, news2: critical }], acked);
    assert.equal(quiet.alerts.length, 0);
    const loud = run([{ t: 2000 + cfg.ackSnoozeMs, news2: critical }], acked);
    assert.equal(loud.alerts.length, 1);
  });
});

describe('evaluate — desescalonamento com histerese', () => {
  const escalated = run([{ t: 0, news2: critical }, { t: 1000, news2: critical }]).state;

  it('melhora breve não desescala', () => {
    const { state, alerts } = run([{ t: 2000, news2: normal }, { t: 3000, news2: normal }, { t: 4000, news2: critical }], escalated);
    assert.equal(state.level, 'CRITICAL');
    assert.equal(alerts.length, 0);
  });

  it('melhora sustentada => RESOLVED (INFO)', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ t: 2000 + i * 10_000, news2: normal }));
    const { state, alerts } = run(steps, escalated);
    assert.equal(state.level, 'NONE');
    assert.equal(alerts.at(-1)!.kind, 'RESOLVED');
    assert.equal(alerts.at(-1)!.priority, 'INFO');
  });

  it('desescala para o maior nível observado durante a melhora', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ t: 2000 + i * 10_000, news2: i === 3 ? medium : normal }));
    const { state } = run(steps, escalated);
    assert.equal(state.level, 'HIGH');
  });
});
