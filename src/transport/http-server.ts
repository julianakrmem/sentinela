/**
 * Servidor HTTP: painel estático, health checks, métricas Prometheus e API de leitura.
 *
 *   GET /health/live   liveness  — o processo responde (não verifica dependências)
 *   GET /health/ready  readiness — Redis acessível e event loop saudável
 *   GET /metrics       formato de exposição Prometheus
 *   GET /api/stats     resumo JSON (usado pelo painel e pelo teste de carga)
 *   GET /api/beds      snapshot dos leitos
 *   GET /api/alerts    últimos alertas
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { TriageService } from '../app/triage-service.js';
import type { Storage } from '../infra/storage.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface HttpDeps {
  storage: Storage;
  service: TriageService;
  metrics: Metrics;
  log: Logger;
  publicDir: string;
  version: string;
  eventLoopLagMs: () => number;
}

export function createHttpServer(deps: HttpDeps) {
  const { storage, metrics, log } = deps;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const stats = () => ({
    storage: storage.kind,
    readingsTotal: metrics.readings.total(),
    readingsPerSecond: Math.round(metrics.throughput.rate() * 10) / 10,
    processingMs: {
      p50: round(metrics.latency.percentile(50)),
      p95: round(metrics.latency.percentile(95)),
      p99: round(metrics.latency.percentile(99)),
    },
    alertsTotal: metrics.alerts.total(),
    rejectedTotal: metrics.rejected.total(),
    ingestConnections: metrics.ingestConnections.get(),
    dashboardClients: metrics.dashboardClients.get(),
    queueDepth: deps.service.pending,
    eventLoopLagMs: round(deps.eventLoopLagMs()),
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'método não permitido' });

    switch (url.pathname) {
      case '/health/live':
        return json(res, 200, { status: 'ok', version: deps.version });
      case '/health/ready': {
        const storageOk = await storage.ping();
        const lag = deps.eventLoopLagMs();
        const ready = storageOk && lag < 1000;
        metrics.storageUp.set(storageOk ? 1 : 0);
        return json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          checks: { storage: { kind: storage.kind, ok: storageOk }, eventLoop: { lagMs: round(lag), ok: lag < 1000 } },
        });
      }
      case '/metrics':
        metrics.queueDepth.set(deps.service.pending);
        metrics.eventLoopLag.set(round(deps.eventLoopLagMs()));
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        return res.end(metrics.registry.render());
      case '/api/stats':
        return json(res, 200, stats());
      case '/api/beds':
        return json(res, 200, await storage.allSummaries());
      case '/api/alerts':
        return json(res, 200, await storage.recentAlerts(Math.min(500, Number(url.searchParams.get('limit')) || 100)));
    }

    // Arquivos estáticos do painel
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(deps.publicDir, rel));
    if (!file.startsWith(deps.publicDir)) return json(res, 403, { error: 'proibido' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      json(res, 404, { error: 'não encontrado' });
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error('erro na requisição HTTP', { err, url: req.url });
      if (!res.headersSent) json(res, 500, { error: 'erro interno' });
    });
  });
}

const round = (v: number) => Math.round(v * 100) / 100;
