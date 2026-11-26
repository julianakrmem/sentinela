import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngestMessage } from '../src/transport/validation.js';
import { createLogger } from '../src/observability/logger.js';
import { Counter, Histogram, Registry } from '../src/observability/metrics.js';

const NOW = 1_700_000_000_000;
const parse = (o: unknown) => parseIngestMessage(JSON.stringify(o), NOW, 30_000);
const vitals = { type: 'vitals', bedId: 'UTI-001', seq: 1, ts: NOW, hr: 80.4, spo2: 96, sbp: 120, rr: 16, temp: 36.84 };

describe('validação do protocolo de ingestão', () => {
  it('aceita leitura válida e normaliza arredondamentos', () => {
    const r = parse(vitals);
    assert.ok(r.ok && r.value.type === 'vitals');
    if (r.ok && r.value.type === 'vitals') {
      assert.equal(r.value.reading.hr, 80);
      assert.equal(r.value.reading.temp, 36.8);
      assert.equal(r.value.reading.consciousness, 'A');
    }
  });

  it('rejeita JSON inválido, bedId inválido e campos ausentes', () => {
    assert.equal(parseIngestMessage('{', NOW, 1).ok, false);
    assert.equal(parse({ ...vitals, bedId: '../etc' }).ok, false);
    const { hr: _hr, ...noHr } = vitals;
    const r = parse(noHr);
    assert.ok(!r.ok && r.error.includes('hr') && r.seq === 1);
  });

  it('rejeita valores fisiologicamente impossíveis, mas aceita FC = 0', () => {
    assert.equal(parse({ ...vitals, spo2: 140 }).ok, false);
    assert.equal(parse({ ...vitals, temp: 50 }).ok, false);
    assert.equal(parse({ ...vitals, hr: 0 }).ok, true);
  });

  it('substitui timestamp com relógio muito divergente pelo do servidor', () => {
    const r = parse({ ...vitals, ts: NOW - 3_600_000 });
    assert.ok(r.ok && r.value.type === 'vitals' && r.value.reading.ts === NOW);
  });

  it('valida consciência e escala de SpO2', () => {
    assert.equal(parse({ ...vitals, consciousness: 'X' }).ok, false);
    assert.equal(parse({ type: 'hello', bedId: 'A1', spo2Scale: 3 }).ok, false);
    assert.equal(parse({ type: 'hello', bedId: 'A1', spo2Scale: 2 }).ok, true);
  });
});

describe('observabilidade', () => {
  it('logger emite JSON de uma linha com campos e herança de contexto', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), base: { service: 's' } }).child({ component: 'c' });
    log.info('olá', { bedId: 'B1', err: new Error('x') });
    log.debug('oculto');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.level, 'info');
    assert.equal(entry.service, 's');
    assert.equal(entry.component, 'c');
    assert.equal(entry.err.message, 'x');
  });

  it('métricas no formato de exposição do Prometheus', () => {
    const reg = new Registry();
    reg.register(new Counter('x_total', 'ajuda')).inc({ priority: 'HIGH' }, 3);
    const h = reg.register(new Histogram('lat_ms', 'lat', [1, 10]));
    h.observe(0.5); h.observe(5);
    const out = reg.render();
    assert.match(out, /# TYPE x_total counter/);
    assert.match(out, /x_total\{priority="HIGH"\} 3/);
    assert.match(out, /lat_ms_bucket\{le="1"\} 1/);
    assert.match(out, /lat_ms_bucket\{le="\+Inf"\} 2/);
  });
});
