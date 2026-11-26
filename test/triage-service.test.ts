/**
 * Testes de integração do caso de uso com o adaptador em memória.
 * Se REDIS_URL estiver definido, a mesma bateria roda também contra o Redis real.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TriageService } from '../src/app/triage-service.js';
import { KeyedQueue } from '../src/app/keyed-queue.js';
import { DEFAULT_POLICY_CONFIG } from '../src/domain/alert-policy.js';
import { DEFAULT_TREND_CONFIG } from '../src/domain/trend.js';
import type { TriageEvent, VitalSigns } from '../src/domain/types.js';
import { MemoryStorage } from '../src/infra/memory-storage.js';
import { RedisStorage } from '../src/infra/redis-storage.js';
import type { Storage } from '../src/infra/storage.js';
import { silentLogger } from '../src/observability/logger.js';
import { createMetrics } from '../src/observability/metrics.js';

const cfg = {
  windowMs: 15 * 60_000, sampleIntervalMs: 5_000, signalTimeoutMs: 15_000, maxQueuePerBed: 50,
  policy: DEFAULT_POLICY_CONFIG, trend: DEFAULT_TREND_CONFIG,
};
const normal = { hr: 72, spo2: 98, sbp: 125, rr: 15, temp: 36.8, consciousness: 'A' as const, onOxygen: false, spo2Scale: 1 as const };
const septic = { ...normal, rr: 26, hr: 125, sbp: 95, temp: 39.4 };

const backends: Array<[string, () => Storage]> = [['memória', () => new MemoryStorage()]];
if (process.env.REDIS_URL) backends.push(['redis', () => RedisStorage.connect(process.env.REDIS_URL!)]);

for (const [name, make] of backends) {
  describe(`TriageService (${name})`, () => {
    let storage: Storage;
    let service: TriageService;
    let now: number;
    let events: TriageEvent[];
    let bed: string;

    beforeEach(async () => {
      storage = make();
      now = 1_700_000_000_000 + Math.floor(Math.random() * 1e9);
      bed = `T-${Math.random().toString(36).slice(2, 8)}`;
      const mine: TriageEvent[] = [];
      events = mine;
      await storage.onEvent((e) => mine.push(e));
      service = new TriageService(storage, cfg, createMetrics(), silentLogger, () => now);
    });
    afterEach(async () => { await storage.close(); });

    const send = (v: typeof normal, dt = 1000) => {
      now += dt;
      return service.ingest({ ...v, bedId: bed, ts: now } as VitalSigns);
    };
    const settle = () => new Promise((r) => setTimeout(r, name === 'redis' ? 80 : 5));

    it('calcula NEWS2 e mantém prioridade NONE para paciente estável', async () => {
      const r = await send(normal);
      assert.equal(r.news2, 0);
      assert.equal(r.priority, 'NONE');
      const summary = await storage.getSummary(bed);
      assert.equal(summary?.news2, 0);
    });

    it('piora séptica gera um alerta CRÍTICO publicado no barramento', async () => {
      await send(normal);
      await send(septic);
      const r = await send(septic);
      assert.equal(r.priority, 'CRITICAL');
      await settle();
      const alerts = events.filter((e) => e.type === 'alert' && e.alert.bedId === bed);
      assert.equal(alerts.length, 1);
      const recent = await storage.recentAlerts(10);
      assert.ok(recent.some((a) => a.bedId === bed && a.priority === 'CRITICAL'));
    });

    it('reconhecimento é registrado e propagado', async () => {
      await send(septic); await send(septic);
      assert.equal(await service.acknowledge(bed, 'x', 'Enf. Teste'), true);
      await settle();
      assert.ok(events.some((e) => e.type === 'ack' && e.bedId === bed && e.by === 'Enf. Teste'));
      assert.equal((await storage.getBedState(bed))?.acknowledgedBy, 'Enf. Teste');
    });

    it('janela temporal detecta piora gradual antes do escore ficar alto', async () => {
      // 3 min de leituras a 1 Hz com FC e FR subindo devagar
      let last;
      for (let i = 0; i < 180; i++) {
        last = await send({ ...normal, hr: 70 + i * 0.2, rr: 14 + i * 0.05, spo2: 98 - Math.floor(i / 40) });
      }
      const state = await storage.getBedState(bed);
      assert.equal(state?.trend?.status, 'deteriorating');
      assert.ok(last!.priority !== 'NONE', `prioridade esperada > NONE, obtida ${last!.priority}`);
    });

    it('watchdog emite SIGNAL_LOST e, na volta, SIGNAL_RESTORED', async () => {
      await send(normal);
      now += cfg.signalTimeoutMs + 1000;
      await service.checkSignals();
      await settle();
      assert.ok(events.some((e) => e.type === 'alert' && e.alert.bedId === bed && e.alert.kind === 'SIGNAL_LOST'));
      await service.checkSignals(); // não duplica
      await send(normal);
      await settle();
      const kinds = events.filter((e) => e.type === 'alert' && e.alert.bedId === bed).map((e) => e.type === 'alert' && e.alert.kind);
      assert.deepEqual(kinds, ['SIGNAL_LOST', 'SIGNAL_RESTORED']);
    });

    it('alta (discharge) remove o leito sem alerta de sinal', async () => {
      await send(normal);
      await service.discharge(bed);
      now += cfg.signalTimeoutMs * 2;
      await service.checkSignals();
      await settle();
      assert.ok(!events.some((e) => e.type === 'alert' && e.alert.bedId === bed), 'nenhum alerta para leito com alta');
      assert.equal(await storage.getSummary(bed), null);
    });
  });
}

describe('KeyedQueue', () => {
  it('serializa por chave e paraleliza entre chaves', async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const task = (k: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { log.push(k); r(); }, ms));
    await Promise.all([q.run('a', task('a1', 30)), q.run('a', task('a2', 1)), q.run('b', task('b1', 5))]);
    assert.deepEqual(log, ['b1', 'a1', 'a2']);
    assert.equal(q.pending, 0);
  });

  it('aplica backpressure quando a fila do leito enche', async () => {
    const q = new KeyedQueue(2);
    const slow = () => new Promise<void>((r) => setTimeout(r, 20));
    const p1 = q.run('a', slow); const p2 = q.run('a', slow);
    await assert.rejects(q.run('a', slow), /cheia/);
    await Promise.all([p1, p2]);
  });

  it('falha de uma tarefa não trava a fila', async () => {
    const q = new KeyedQueue();
    await assert.rejects(q.run('a', async () => { throw new Error('boom'); }));
    assert.equal(await q.run('a', async () => 42), 42);
  });
});
