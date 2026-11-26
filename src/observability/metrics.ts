/**
 * Métricas no formato de exposição do Prometheus (text/plain; version=0.0.4).
 * Implementação mínima e sem dependências de Counter, Gauge e Histogram com labels,
 * mais um reservatório para percentis exatos exibidos no painel (/api/stats).
 */
type Labels = Record<string, string>;
const labelKey = (l: Labels = {}) =>
  Object.keys(l).sort().map((k) => `${k}="${String(l[k]).replace(/["\\\n]/g, '_')}"`).join(',');
const fmt = (name: string, lk: string, v: number) => `${name}${lk ? `{${lk}}` : ''} ${v}`;

interface Metric { render(): string }

export class Counter implements Metric {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels?: Labels, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels?: Labels) { return this.values.get(labelKey(labels)) ?? 0; }
  total() { let t = 0; for (const v of this.values.values()) t += v; return t; }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(fmt(this.name, '', 0));
    for (const [k, v] of this.values) lines.push(fmt(this.name, k, v));
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string, private collect?: () => number) {}
  set(v: number, labels?: Labels) { this.values.set(labelKey(labels), v); }
  inc(labels?: Labels, by = 1) { const k = labelKey(labels); this.values.set(k, (this.values.get(k) ?? 0) + by); }
  dec(labels?: Labels, by = 1) { this.inc(labels, -by); }
  get(labels?: Labels) { return this.collect ? this.collect() : this.values.get(labelKey(labels)) ?? 0; }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.collect) lines.push(fmt(this.name, '', this.collect()));
    else if (this.values.size === 0) lines.push(fmt(this.name, '', 0));
    else for (const [k, v] of this.values) lines.push(fmt(this.name, k, v));
    return lines.join('\n');
  }
}

export class Histogram implements Metric {
  private counts: number[];
  private sum = 0;
  private count = 0;
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(v: number) {
    this.sum += v;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) this.counts[i]!++;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{le="${b}"} ${this.counts[i]}`));
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`, `${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

/** Janela circular para percentis exatos das últimas N observações. */
export class Reservoir {
  private buf: Float64Array;
  private i = 0;
  private n = 0;
  constructor(size = 10_000) { this.buf = new Float64Array(size); }
  add(v: number) { this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; this.n = Math.min(this.n + 1, this.buf.length); }
  percentile(p: number) {
    if (this.n === 0) return 0;
    const s = Array.from(this.buf.subarray(0, this.n)).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
  }
}

/** Taxa por segundo numa janela deslizante de `seconds`. */
export class RateMeter {
  private slots: Int32Array;
  private stamps: Float64Array;
  constructor(private seconds = 10) {
    this.slots = new Int32Array(seconds);
    this.stamps = new Float64Array(seconds);
  }
  mark(now = Date.now()) {
    const sec = Math.floor(now / 1000);
    const idx = sec % this.seconds;
    if (this.stamps[idx] !== sec) { this.stamps[idx] = sec; this.slots[idx] = 0; }
    this.slots[idx]!++;
  }
  rate(now = Date.now()) {
    const sec = Math.floor(now / 1000);
    let total = 0;
    // ignora o segundo corrente (incompleto)
    for (let i = 0; i < this.seconds; i++) {
      const s = this.stamps[i]!;
      if (s < sec && s >= sec - this.seconds) total += this.slots[i]!;
    }
    return total / (this.seconds - 1);
  }
}

export class Registry {
  private metrics: Metric[] = [];
  register<T extends Metric>(m: T): T { this.metrics.push(m); return m; }
  render() { return this.metrics.map((m) => m.render()).join('\n') + '\n'; }
}

const MS_BUCKETS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

export function createMetrics() {
  const registry = new Registry();
  const startedAt = Date.now();
  const m = {
    registry,
    readings: registry.register(new Counter('sentinela_readings_total', 'Leituras de sinais vitais processadas')),
    rejected: registry.register(new Counter('sentinela_readings_rejected_total', 'Leituras rejeitadas, por motivo')),
    alerts: registry.register(new Counter('sentinela_alerts_total', 'Alertas emitidos, por prioridade e tipo')),
    acks: registry.register(new Counter('sentinela_alert_acks_total', 'Alertas reconhecidos pela enfermagem')),
    processing: registry.register(new Histogram('sentinela_processing_duration_ms', 'Latência de processamento por leitura (ms)', MS_BUCKETS)),
    ingestConnections: registry.register(new Gauge('sentinela_ingest_connections', 'Conexões WebSocket de monitores abertas')),
    dashboardClients: registry.register(new Gauge('sentinela_dashboard_clients', 'Painéis de enfermagem conectados')),
    bedsByPriority: registry.register(new Gauge('sentinela_beds_by_priority', 'Leitos por prioridade atual (visão desta instância)')),
    queueDepth: registry.register(new Gauge('sentinela_queue_depth', 'Leituras aguardando processamento')),
    storageUp: registry.register(new Gauge('sentinela_storage_up', 'Armazenamento acessível (1) ou não (0)')),
    uptime: registry.register(new Gauge('sentinela_uptime_seconds', 'Tempo desde o início do processo', () => Math.round((Date.now() - startedAt) / 1000))),
    eventLoopLag: registry.register(new Gauge('sentinela_event_loop_lag_ms', 'Atraso do event loop (ms)')),
    heapUsed: registry.register(new Gauge('sentinela_heap_used_bytes', 'Heap V8 em uso', () => process.memoryUsage().heapUsed)),
    latency: new Reservoir(10_000),
    throughput: new RateMeter(10),
  };
  return m;
}

export type Metrics = ReturnType<typeof createMetrics>;
