/**
 * Caso de uso central: recebe uma leitura, calcula NEWS2, atualiza a janela temporal,
 * avalia tendência, aplica a política de alertas e publica eventos.
 */
import { randomUUID } from 'node:crypto';
import { evaluate, initialBedState } from '../domain/alert-policy.js';
import { computeNews2 } from '../domain/news2.js';
import { analyzeTrend } from '../domain/trend.js';
import {
  PRIORITY_RANK,
  type Alert, type BedState, type BedSummary, type News2Result, type Priority, type VitalSigns,
} from '../domain/types.js';
import type { Storage } from '../infra/storage.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { KeyedQueue } from './keyed-queue.js';
import type { AppConfig } from '../config.js';

export interface BedMeta { label?: string; patient?: string }

export interface IngestResult {
  news2: number;
  risk: News2Result['risk'];
  priority: Priority;
  alerts: Alert[];
}

type ServiceConfig = Pick<AppConfig,
  'windowMs' | 'sampleIntervalMs' | 'signalTimeoutMs' | 'maxQueuePerBed' | 'policy' | 'trend'>;

export class TriageService {
  private readonly queue: KeyedQueue;
  private readonly meta = new Map<string, BedMeta>();
  private readonly priorities = new Map<string, Priority>();

  constructor(
    private readonly storage: Storage,
    private readonly cfg: ServiceConfig,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {
    this.queue = new KeyedQueue(cfg.maxQueuePerBed);
  }

  get pending() { return this.queue.pending; }

  registerBed(bedId: string, meta: BedMeta) {
    this.meta.set(bedId, { ...this.meta.get(bedId), ...meta });
  }

  ingest(v: VitalSigns): Promise<IngestResult> {
    return this.queue.run(v.bedId, () => this.process(v));
  }

  private async process(v: VitalSigns): Promise<IngestResult> {
    const started = performance.now();
    const now = this.clock();
    const prev = (await this.storage.getBedState(v.bedId)) ?? initialBedState(v.bedId, now);
    const news2 = computeNews2(v);

    // Janela temporal: amostragem a cada sampleIntervalMs mantém a janela pequena
    // (15 min / 5 s = 180 pontos) mesmo com monitores enviando a 1 Hz ou mais.
    let trend = prev.trend;
    let lastSampleTs = prev.lastSampleTs;
    if (now - prev.lastSampleTs >= this.cfg.sampleIntervalMs) {
      const window = await this.storage.appendSample(v.bedId, {
        ts: now, news2: news2.total, hr: v.hr, spo2: v.spo2, sbp: v.sbp, rr: v.rr, temp: v.temp,
      }, this.cfg.windowMs);
      trend = analyzeTrend(window, this.cfg.trend);
      lastSampleTs = now;
    }

    const out = evaluate(prev, { bedId: v.bedId, now, news2, trend }, this.cfg.policy, this.newId);
    const state: BedState = { ...out.state, lastSampleTs };
    const alerts = [...out.alerts];

    if (prev.signalLost) {
      delete state.signalLost;
      alerts.unshift(this.signalAlert(v.bedId, 'SIGNAL_RESTORED', 'INFO', now, news2.total));
    }

    await this.storage.saveBed(state, this.summarize(v, state, news2, now), { touchLastSeen: now });
    for (const alert of alerts) await this.emit(alert);

    this.trackPriority(v.bedId, state.level);
    const elapsed = performance.now() - started;
    this.metrics.readings.inc();
    this.metrics.processing.observe(elapsed);
    this.metrics.latency.add(elapsed);
    this.metrics.throughput.mark(now);

    return { news2: news2.total, risk: news2.risk, priority: state.level, alerts };
  }

  acknowledge(bedId: string, alertId: string, by: string): Promise<boolean> {
    return this.queue.run(bedId, async () => {
      const state = await this.storage.getBedState(bedId);
      if (!state || state.level === 'NONE') return false;
      const now = this.clock();
      state.acknowledgedAt = now;
      state.acknowledgedBy = by;
      const summary = await this.storage.getSummary(bedId);
      if (summary) await this.storage.saveBed(state, { ...summary, acknowledged: true });
      await this.storage.publishEvent({ type: 'ack', bedId, alertId: state.activeAlertId ?? alertId, by, at: now });
      this.metrics.acks.inc();
      this.log.info('alerta reconhecido', { bedId, alertId, level: state.level });
      return true;
    });
  }

  /** Alta/desligamento intencional do monitor: remove o leito sem gerar "sinal perdido". */
  discharge(bedId: string): Promise<void> {
    return this.queue.run(bedId, async () => {
      await this.storage.removeBed(bedId);
      await this.storage.publishEvent({ type: 'discharge', bedId });
      this.priorities.delete(bedId);
      this.meta.delete(bedId);
      this.refreshPriorityGauge();
    });
  }

  /** Watchdog: monitores que pararam de enviar dados viram alerta de perda de sinal. */
  async checkSignals(): Promise<number> {
    const now = this.clock();
    const stale = await this.storage.staleBeds(now - this.cfg.signalTimeoutMs);
    await Promise.all(stale.map((bedId) => this.queue.run(bedId, async () => {
      const state = await this.storage.getBedState(bedId);
      await this.storage.forgetLastSeen(bedId);
      if (!state || state.signalLost) return;
      state.signalLost = true;
      const summary = await this.storage.getSummary(bedId);
      if (summary) await this.storage.saveBed(state, { ...summary, signalLost: true });
      // Perda de sinal num paciente já grave é mais urgente.
      const priority = PRIORITY_RANK[state.level] >= PRIORITY_RANK.HIGH ? 'HIGH' : 'MEDIUM';
      await this.emit(this.signalAlert(bedId, 'SIGNAL_LOST', priority, now, summary?.news2 ?? null));
    })));
    return stale.length;
  }

  private signalAlert(
    bedId: string, kind: 'SIGNAL_LOST' | 'SIGNAL_RESTORED', priority: Alert['priority'],
    now: number, news2: number | null,
  ): Alert {
    return {
      id: this.newId(),
      bedId,
      kind,
      priority,
      title: kind === 'SIGNAL_LOST' ? 'Sinal do monitor perdido' : 'Sinal do monitor restabelecido',
      reasons: kind === 'SIGNAL_LOST'
        ? [`Sem leituras há mais de ${Math.round(this.cfg.signalTimeoutMs / 1000)} s — verificar sensor/paciente`]
        : ['Leituras voltaram a chegar'],
      news2,
      createdAt: now,
    };
  }

  private async emit(alert: Alert) {
    await this.storage.publishEvent({ type: 'alert', alert });
    this.metrics.alerts.inc({ priority: alert.priority, kind: alert.kind });
    const level = alert.priority === 'CRITICAL' || alert.priority === 'HIGH' ? 'warn' : 'info';
    this.log[level]('alerta emitido', {
      alertId: alert.id, bedId: alert.bedId, kind: alert.kind, priority: alert.priority, news2: alert.news2,
    });
  }

  private summarize(v: VitalSigns, state: BedState, news2: News2Result, now: number): BedSummary {
    const meta = this.meta.get(v.bedId) ?? {};
    const { bedId: _b, seq: _s, ...vitals } = v;
    return {
      bedId: v.bedId,
      label: meta.label ?? v.bedId,
      patient: meta.patient,
      updatedAt: now,
      vitals,
      news2: news2.total,
      subscores: news2.subscores,
      risk: news2.risk,
      priority: state.level,
      trend: state.trend?.status ?? 'insufficient',
      acknowledged: Boolean(state.acknowledgedAt),
      activeAlertId: state.activeAlertId,
      signalLost: Boolean(state.signalLost),
    };
  }

  private trackPriority(bedId: string, p: Priority) {
    if (this.priorities.get(bedId) === p) return;
    this.priorities.set(bedId, p);
    this.refreshPriorityGauge();
  }

  private refreshPriorityGauge() {
    const counts: Record<Priority, number> = { NONE: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const p of this.priorities.values()) counts[p]++;
    for (const [p, n] of Object.entries(counts)) this.metrics.bedsByPriority.set(n, { priority: p });
  }
}
