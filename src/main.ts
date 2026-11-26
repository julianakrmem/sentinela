/**
 * Composition root: monta as dependências, sobe HTTP + WebSockets e o watchdog.
 */
import { resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { TriageService } from './app/triage-service.js';
import { MemoryStorage } from './infra/memory-storage.js';
import { RedisStorage } from './infra/redis-storage.js';
import type { Storage } from './infra/storage.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { attachDashboardHub } from './transport/dashboard-hub.js';
import { createHttpServer } from './transport/http-server.js';
import { attachIngestGateway } from './transport/ingest-gateway.js';

const VERSION = process.env.npm_package_version ?? '1.0.0';

async function main() {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, base: { service: 'sentinela', version: VERSION, pid: process.pid } });
  const metrics = createMetrics();

  let storage: Storage;
  if (cfg.redisUrl) {
    storage = RedisStorage.connect(cfg.redisUrl, cfg.alertLogSize);
  } else {
    log.warn('REDIS_URL não definido: usando armazenamento em memória (somente desenvolvimento, instância única)');
    storage = new MemoryStorage(cfg.alertLogSize);
  }

  const service = new TriageService(storage, cfg, metrics, log.child({ component: 'triage' }));

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const lag = () => Math.max(0, loop.mean / 1e6 - 20);
  setInterval(() => loop.reset(), 10_000).unref();

  const server = createHttpServer({
    storage, service, metrics, log: log.child({ component: 'http' }),
    publicDir: resolve(process.cwd(), 'public'), version: VERSION, eventLoopLagMs: lag,
  });

  const ingestWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const dashboardWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  attachIngestGateway(ingestWss, { service, metrics, log: log.child({ component: 'ingest' }), maxClockSkewMs: cfg.maxClockSkewMs });
  await attachDashboardHub(dashboardWss, { storage, service, metrics, log: log.child({ component: 'dashboard' }), flushMs: cfg.dashboardFlushMs });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const target = pathname === '/ws/ingest' ? ingestWss : pathname === '/ws/dashboard' ? dashboardWss : null;
    if (!target) { socket.destroy(); return; }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  const watchdog = setInterval(() => {
    service.checkSignals().then((n) => {
      if (n > 0) log.info('watchdog: leitos sem sinal', { count: n });
    }).catch((err) => log.error('watchdog falhou', { err }));
  }, cfg.watchdogIntervalMs);

  const storageProbe = setInterval(() => {
    storage.ping().then((ok) => {
      metrics.storageUp.set(ok ? 1 : 0);
      if (!ok) log.error('armazenamento inacessível', { storage: storage.kind });
    }).catch(() => metrics.storageUp.set(0));
  }, 10_000);
  storageProbe.unref();
  metrics.storageUp.set((await storage.ping()) ? 1 : 0);

  server.listen(cfg.port, cfg.host, () => {
    log.info('sentinela no ar', {
      port: cfg.port, storage: storage.kind, windowMs: cfg.windowMs, sampleIntervalMs: cfg.sampleIntervalMs,
    });
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('encerrando', { signal });
    clearInterval(watchdog);
    for (const wss of [ingestWss, dashboardWss]) {
      for (const c of wss.clients) c.close(1001, 'servidor reiniciando');
      wss.close();
    }
    server.close();
    // aguarda filas drenarem (até 5 s) antes de fechar o Redis
    const deadline = Date.now() + 5_000;
    while (service.pending > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('promise rejeitada sem tratamento', { err }));
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: 'falha na inicialização', err: String(err?.stack ?? err) }) + '\n');
  process.exit(1);
});
