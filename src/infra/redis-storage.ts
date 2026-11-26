/**
 * Adaptador Redis.
 *
 * Modelo de chaves (o trecho entre chaves é hash tag: todas as chaves de um leito
 * caem no mesmo slot num Redis Cluster):
 *   sentinela:bed:{B-101}:state    STRING  JSON do BedState (TTL 24 h)
 *   sentinela:bed:{B-101}:window   ZSET    score = ts, membro = amostra compacta (janela deslizante)
 *   sentinela:beds:latest          HASH    bedId -> BedSummary (snapshot do painel)
 *   sentinela:beds:lastseen        ZSET    score = último sinal (watchdog de perda de sinal)
 *   sentinela:alerts               STREAM  log de alertas (MAXLEN ~ N) para replay no painel
 *   sentinela:ack:<alertId>        STRING  reconhecimento do alerta (TTL 24 h)
 * Canais pub/sub: sentinela:events (alertas/acks), sentinela:beds (atualizações de leito).
 */
import { Redis } from 'ioredis';
import type { Alert, BedState, BedSummary, TrendSample, TriageEvent } from '../domain/types.js';
import type { SaveOptions, Storage } from './storage.js';

const P = 'sentinela';
const K = {
  state: (id: string) => `${P}:bed:{${id}}:state`,
  window: (id: string) => `${P}:bed:{${id}}:window`,
  latest: `${P}:beds:latest`,
  lastSeen: `${P}:beds:lastseen`,
  alerts: `${P}:alerts`,
  ack: (alertId: string) => `${P}:ack:${alertId}`,
  chEvents: `${P}:events`,
  chBeds: `${P}:beds`,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** Amostra compacta "ts|news2|hr|spo2|sbp|rr|temp" — ~35 bytes em vez de ~90 em JSON. */
export const encodeSample = (s: TrendSample) =>
  `${s.ts}|${s.news2}|${s.hr}|${s.spo2}|${s.sbp}|${s.rr}|${s.temp}`;
export function decodeSample(raw: string): TrendSample {
  const [ts, news2, hr, spo2, sbp, rr, temp] = raw.split('|').map(Number);
  return { ts: ts!, news2: news2!, hr: hr!, spo2: spo2!, sbp: sbp!, rr: rr!, temp: temp! };
}

export class RedisStorage implements Storage {
  readonly kind = 'redis' as const;
  private readonly sub: Redis;
  private eventHandlers: Array<(e: TriageEvent) => void> = [];
  private bedHandlers: Array<(s: BedSummary) => void> = [];
  private subscribed = false;

  constructor(private readonly redis: Redis, private readonly alertLogSize = 1000) {
    this.sub = redis.duplicate();
  }

  static connect(url: string, alertLogSize?: number): RedisStorage {
    const client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true, // agrupa comandos concorrentes num único round-trip
    });
    return new RedisStorage(client, alertLogSize);
  }

  async getBedState(bedId: string) {
    const raw = await this.redis.get(K.state(bedId));
    return raw ? (JSON.parse(raw) as BedState) : null;
  }

  async saveBed(state: BedState, summary: BedSummary, opts: SaveOptions = {}) {
    const json = JSON.stringify(summary);
    const tx = this.redis.multi()
      .set(K.state(state.bedId), JSON.stringify(state), 'PX', DAY_MS)
      .hset(K.latest, summary.bedId, json)
      .publish(K.chBeds, json);
    if (opts.touchLastSeen !== undefined) tx.zadd(K.lastSeen, opts.touchLastSeen, state.bedId);
    await tx.exec();
  }

  async appendSample(bedId: string, sample: TrendSample, windowMs: number) {
    const key = K.window(bedId);
    const res = await this.redis.multi()
      .zadd(key, sample.ts, encodeSample(sample))
      .zremrangebyscore(key, '-inf', `(${sample.ts - windowMs}`)
      .zrange(key, 0, -1)
      .pexpire(key, windowMs * 2)
      .exec();
    const members = (res?.[2]?.[1] ?? []) as string[];
    return members.map(decodeSample);
  }

  async publishEvent(event: TriageEvent) {
    const json = JSON.stringify(event);
    const tx = this.redis.multi();
    if (event.type === 'alert') {
      tx.xadd(K.alerts, 'MAXLEN', '~', this.alertLogSize, '*', 'data', JSON.stringify(event.alert));
    } else if (event.type === 'ack') {
      tx.set(K.ack(event.alertId), JSON.stringify({ by: event.by, at: event.at }), 'PX', DAY_MS);
    }
    tx.publish(K.chEvents, json);
    await tx.exec();
  }

  async recentAlerts(limit: number) {
    const entries: Array<[id: string, fields: string[]]> =
      await this.redis.xrevrange(K.alerts, '+', '-', 'COUNT', limit);
    const alerts = entries.map(([, fields]) => JSON.parse(fields[1]!) as Alert);
    if (alerts.length === 0) return [];
    const acks: Array<string | null> = await this.redis.mget(...alerts.map((a) => K.ack(a.id)));
    return alerts.map((a, i) => {
      const raw = acks[i];
      return raw ? { ...a, ack: JSON.parse(raw) as { by: string; at: number } } : a;
    });
  }

  async allSummaries() {
    const all: Record<string, string> = await this.redis.hgetall(K.latest);
    return Object.values(all).map((v) => JSON.parse(v) as BedSummary);
  }

  async getSummary(bedId: string) {
    const raw = await this.redis.hget(K.latest, bedId);
    return raw ? (JSON.parse(raw) as BedSummary) : null;
  }

  async staleBeds(before: number) {
    return this.redis.zrangebyscore(K.lastSeen, '-inf', `(${before}`);
  }

  async forgetLastSeen(bedId: string) {
    await this.redis.zrem(K.lastSeen, bedId);
  }

  async removeBed(bedId: string) {
    await this.redis.multi()
      .del(K.state(bedId), K.window(bedId))
      .hdel(K.latest, bedId)
      .zrem(K.lastSeen, bedId)
      .exec();
  }

  private async ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.sub.on('message', (channel: string, message: string) => {
      const data = JSON.parse(message);
      if (channel === K.chEvents) this.eventHandlers.forEach((h) => h(data));
      else if (channel === K.chBeds) this.bedHandlers.forEach((h) => h(data));
    });
    await this.sub.subscribe(K.chEvents, K.chBeds);
  }

  async onEvent(handler: (e: TriageEvent) => void) {
    this.eventHandlers.push(handler);
    await this.ensureSubscribed();
  }

  async onBedUpdate(handler: (s: BedSummary) => void) {
    this.bedHandlers.push(handler);
    await this.ensureSubscribed();
  }

  async ping() {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close() {
    await Promise.allSettled([this.sub.quit(), this.redis.quit()]);
  }
}
