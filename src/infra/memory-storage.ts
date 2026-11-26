/**
 * Adaptador em memória: usado nos testes e no modo dev sem Redis.
 * Não compartilha estado entre processos — não usar com múltiplas instâncias.
 */
import { EventEmitter } from 'node:events';
import type { Alert, BedState, BedSummary, TrendSample, TriageEvent } from '../domain/types.js';
import type { SaveOptions, Storage } from './storage.js';

export class MemoryStorage implements Storage {
  readonly kind = 'memory' as const;
  private states = new Map<string, BedState>();
  private summaries = new Map<string, BedSummary>();
  private windows = new Map<string, TrendSample[]>();
  private lastSeen = new Map<string, number>();
  private alerts: Alert[] = [];
  private acks = new Map<string, { by: string; at: number }>();
  private bus = new EventEmitter();

  constructor(private readonly alertLogSize = 1000) {
    this.bus.setMaxListeners(0);
  }

  async getBedState(bedId: string) {
    const s = this.states.get(bedId);
    return s ? structuredClone(s) : null;
  }

  async saveBed(state: BedState, summary: BedSummary, opts: SaveOptions = {}) {
    this.states.set(state.bedId, structuredClone(state));
    this.summaries.set(summary.bedId, summary);
    if (opts.touchLastSeen !== undefined) this.lastSeen.set(state.bedId, opts.touchLastSeen);
    queueMicrotask(() => this.bus.emit('bed', summary));
  }

  async appendSample(bedId: string, sample: TrendSample, windowMs: number) {
    const w = this.windows.get(bedId) ?? [];
    w.push(sample);
    const cutoff = sample.ts - windowMs;
    while (w.length && w[0]!.ts < cutoff) w.shift();
    this.windows.set(bedId, w);
    return [...w];
  }

  async publishEvent(event: TriageEvent) {
    if (event.type === 'alert') {
      this.alerts.push(event.alert);
      if (this.alerts.length > this.alertLogSize) this.alerts.shift();
    } else if (event.type === 'ack') {
      this.acks.set(event.alertId, { by: event.by, at: event.at });
    }
    queueMicrotask(() => this.bus.emit('event', event));
  }

  async recentAlerts(limit: number) {
    return this.alerts.slice(-limit).reverse().map((a) => {
      const ack = this.acks.get(a.id);
      return ack ? { ...a, ack } : a;
    });
  }

  async allSummaries() {
    return [...this.summaries.values()];
  }

  async getSummary(bedId: string) {
    return this.summaries.get(bedId) ?? null;
  }

  async staleBeds(before: number) {
    return [...this.lastSeen].filter(([, ts]) => ts < before).map(([id]) => id);
  }

  async forgetLastSeen(bedId: string) {
    this.lastSeen.delete(bedId);
  }

  async removeBed(bedId: string) {
    this.states.delete(bedId);
    this.summaries.delete(bedId);
    this.windows.delete(bedId);
    this.lastSeen.delete(bedId);
  }

  async onEvent(handler: (e: TriageEvent) => void) {
    this.bus.on('event', handler);
  }

  async onBedUpdate(handler: (s: BedSummary) => void) {
    this.bus.on('bed', handler);
  }

  async ping() {
    return true;
  }

  async close() {
    this.bus.removeAllListeners();
  }
}
