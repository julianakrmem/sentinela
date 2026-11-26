/**
 * Simulador de monitores multiparamétricos + teste de carga.
 *
 *   npm run simulate                       # 24 leitos, contínuo (demo do painel)
 *   npm run load-test                      # 500 leitos, 60 s, relatório + verificação de SLO
 *   tsx sim/run.ts --beds 1000 --interval 500 --duration 120 --report out.json
 *
 * Cada leito abre a SUA conexão WebSocket (como um monitor de beira-leito real),
 * envia "hello" e depois uma leitura a cada --interval ms. O tempo de ida e volta
 * (envio -> ack com NEWS2 calculado) é medido no cliente.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { SyntheticPatient, pickProfile, type Profile } from './patient-model.js';
import { bedLabel, createRng, syntheticIdentity } from './synthetic.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:3000' },
    beds: { type: 'string', default: '24' },
    interval: { type: 'string', default: '1000' },
    duration: { type: 'string', default: '0' },
    ramp: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '42' },
    'time-scale': { type: 'string', default: '1' },
    report: { type: 'string' },
    'slo-p95': { type: 'string', default: '100' },
    'slo-error-rate': { type: 'string', default: '0.001' },
    'no-bye': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

const BEDS = Number(args.beds);
const INTERVAL = Number(args.interval);
const DURATION = Number(args.duration) * 1000;
const RAMP = Number(args.ramp);
const BASE = args.url!.replace(/\/$/, '');
const HTTP_BASE = BASE.replace(/^ws/, 'http');
const rng = createRng(Number(args.seed));

const rtts: number[] = [];
const counters = { sent: 0, acked: 0, errors: 0, connectFailures: 0, disconnects: 0 };
const alertsSeen: Record<string, number> = {};
const profiles: Record<Profile, number> = { stable: 0, sepsis: 0, respiratory: 0, copd: 0, recovering: 0, artifact: 0 };
const sockets: WebSocket[] = [];
const timers: NodeJS.Timeout[] = [];
let stopping = false;
const startedAt = Date.now();

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function startBed(index: number) {
  const { bedId, label } = bedLabel(index);
  const profile = pickProfile(rng);
  profiles[profile]++;
  const patient = new SyntheticPatient(profile, createRng(Number(args.seed) * 7919 + index), Number(args['time-scale']));
  const who = syntheticIdentity(rng);
  const inflight = new Map<number, number>();
  let seq = 0;
  const t0 = Date.now();

  const ws = new WebSocket(`${BASE}/ws/ingest`);
  sockets.push(ws);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'hello', bedId, label, spo2Scale: patient.spo2Scale,
      patient: `${who.name}, ${who.age}a (sintético)`,
    }));
    const tick = () => {
      if (stopping || ws.readyState !== WebSocket.OPEN) return;
      const r = patient.at(Date.now() - t0);
      const s = ++seq;
      inflight.set(s, performance.now());
      ws.send(JSON.stringify({ type: 'vitals', bedId, seq: s, ts: Date.now(), ...r }));
      counters.sent++;
    };
    // desfasa os leitos dentro do intervalo para não chegarem todos no mesmo milissegundo
    const t = setTimeout(() => { tick(); timers.push(setInterval(tick, INTERVAL)); }, rng.int(0, INTERVAL));
    timers.push(t);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ack') {
      const sentAt = inflight.get(msg.seq);
      if (sentAt !== undefined) {
        rtts.push(performance.now() - sentAt);
        inflight.delete(msg.seq);
      }
      counters.acked++;
    } else if (msg.type === 'error') {
      counters.errors++;
      if (msg.seq) inflight.delete(msg.seq);
    }
  });
  ws.on('error', () => { if (ws.readyState !== WebSocket.OPEN) counters.connectFailures++; });
  ws.on('close', () => { if (!stopping) counters.disconnects++; });
  return { ws, bedId };
}

function watchAlerts() {
  const ws = new WebSocket(`${BASE}/ws/dashboard`);
  let snapshotDone = false;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'snapshot') { snapshotDone = true; return; }
    if (snapshotDone && msg.type === 'alert') {
      const k = `${msg.alert.priority}:${msg.alert.kind}`;
      alertsSeen[k] = (alertsSeen[k] ?? 0) + 1;
    }
  });
  ws.on('error', () => {});
  return ws;
}

function statusLine() {
  const s = [...rtts].sort((a, b) => a - b);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const alerts = Object.values(alertsSeen).reduce((a, b) => a + b, 0);
  console.log(`[${elapsed}s] conexões=${sockets.filter((w) => w.readyState === WebSocket.OPEN).length}/${BEDS} `
    + `enviadas=${counters.sent} acks=${counters.acked} erros=${counters.errors} `
    + `rtt p50=${percentile(s, 50).toFixed(1)}ms p95=${percentile(s, 95).toFixed(1)}ms alertas=${alerts}`);
}

async function finish() {
  stopping = true;
  timers.forEach((t) => clearInterval(t));
  await new Promise((r) => setTimeout(r, 1500)); // espera acks em voo
  const elapsedS = (Date.now() - startedAt) / 1000;

  let server: unknown = null;
  try { server = await (await fetch(`${HTTP_BASE}/api/stats`)).json(); } catch { /* opcional */ }

  if (!args['no-bye']) {
    for (let i = 0; i < BEDS; i++) {
      const ws = sockets[i];
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bye', bedId: bedLabel(i).bedId }));
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  sockets.forEach((ws) => ws.close());

  const sorted = [...rtts].sort((a, b) => a - b);
  const lost = counters.sent - counters.acked - counters.errors;
  const errorRate = counters.sent ? (counters.errors + Math.max(0, lost)) / counters.sent : 0;
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    config: { beds: BEDS, intervalMs: INTERVAL, durationS: DURATION / 1000, seed: Number(args.seed) },
    profiles,
    totals: { ...counters, unacked: Math.max(0, lost), errorRate: Number(errorRate.toFixed(5)) },
    throughput: { readingsPerSecond: Math.round((counters.acked / elapsedS) * 10) / 10, targetPerSecond: Math.round((BEDS * 1000) / INTERVAL) },
    roundTripMs: {
      p50: +percentile(sorted, 50).toFixed(2), p95: +percentile(sorted, 95).toFixed(2),
      p99: +percentile(sorted, 99).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2),
    },
    alertsDelivered: alertsSeen,
    server,
    slo: { p95Ms: Number(args['slo-p95']), maxErrorRate: Number(args['slo-error-rate']) },
    passed: false,
  };
  report.passed = report.roundTripMs.p95 <= report.slo.p95Ms
    && errorRate <= report.slo.maxErrorRate
    && counters.connectFailures === 0;

  console.log('\n══════════ Relatório do teste de carga ══════════');
  console.table({
    'Leitos': BEDS,
    'Leituras/s (alvo)': report.throughput.targetPerSecond,
    'Leituras/s (obtido)': report.throughput.readingsPerSecond,
    'Leituras enviadas': counters.sent,
    'Acks recebidos': counters.acked,
    'Erros': counters.errors,
    'Falhas de conexão': counters.connectFailures,
    'RTT p50 (ms)': report.roundTripMs.p50,
    'RTT p95 (ms)': report.roundTripMs.p95,
    'RTT p99 (ms)': report.roundTripMs.p99,
    'RTT máx (ms)': report.roundTripMs.max,
  });
  console.log('Perfis sintéticos:', profiles);
  console.log('Alertas entregues ao painel:', alertsSeen);
  console.log(report.passed
    ? `✅ SLO atendido (p95 ≤ ${report.slo.p95Ms} ms, erro ≤ ${report.slo.maxErrorRate * 100}%)`
    : `❌ SLO violado (p95 ≤ ${report.slo.p95Ms} ms, erro ≤ ${report.slo.maxErrorRate * 100}%)`);

  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, JSON.stringify(report, null, 2));
    console.log(`Relatório salvo em ${args.report}`);
  }
  process.exit(report.passed ? 0 : 1);
}

console.log(`Simulando ${BEDS} leitos sintéticos → ${BASE} (intervalo ${INTERVAL} ms, `
  + `${DURATION ? `${DURATION / 1000} s` : 'contínuo'}, semente ${args.seed})`);
const dash = watchAlerts();
for (let i = 0; i < BEDS; i++) {
  setTimeout(() => startBed(i), Math.floor((i / BEDS) * RAMP));
}
const status = setInterval(() => { if (!args.quiet) statusLine(); }, 5000);
if (DURATION > 0) setTimeout(() => { clearInterval(status); dash.close(); void finish(); }, DURATION + RAMP);
process.on('SIGINT', () => { clearInterval(status); dash.close(); void finish(); });
