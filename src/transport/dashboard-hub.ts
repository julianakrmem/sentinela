/**
 * Hub do painel de enfermagem (/ws/dashboard).
 *
 *  - Ao conectar: snapshot com todos os leitos + últimos alertas (replay do stream).
 *  - Alertas e reconhecimentos: repassados imediatamente.
 *  - Atualizações de leito: agregadas e enviadas em lote a cada `flushMs`
 *    (com 500 leitos a 1 Hz, o navegador recebe 1 mensagem/s em vez de 500).
 *  - Mensagem do cliente: {"type":"ack","bedId":"...","alertId":"...","by":"Enf. Fulana"}
 */
import type { WebSocket, WebSocketServer } from 'ws';
import type { BedSummary, TriageEvent } from '../domain/types.js';
import type { TriageService } from '../app/triage-service.js';
import type { Storage } from '../infra/storage.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';

export async function attachDashboardHub(
  wss: WebSocketServer,
  deps: { storage: Storage; service: TriageService; metrics: Metrics; log: Logger; flushMs: number },
) {
  const { storage, service, metrics, log } = deps;
  const pending = new Map<string, BedSummary>();

  const broadcast = (payload: unknown) => {
    const json = JSON.stringify(payload);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(json);
  };

  await storage.onBedUpdate((s) => { pending.set(s.bedId, s); });
  await storage.onEvent((e: TriageEvent) => {
    if (e.type === 'discharge') pending.delete(e.bedId);
    broadcast(e);
  });

  const flush = setInterval(() => {
    if (pending.size === 0 || wss.clients.size === 0) { pending.clear(); return; }
    broadcast({ type: 'beds', beds: [...pending.values()] });
    pending.clear();
  }, deps.flushMs);
  flush.unref();
  wss.on('close', () => clearInterval(flush));

  wss.on('connection', async (ws: WebSocket) => {
    metrics.dashboardClients.inc();
    ws.on('close', () => metrics.dashboardClients.dec());
    ws.on('error', (err) => log.warn('erro no socket do painel', { err }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === 'ack' && typeof msg.bedId === 'string') {
          const by = typeof msg.by === 'string' && msg.by.trim() ? msg.by.trim().slice(0, 60) : 'enfermagem';
          await service.acknowledge(msg.bedId, String(msg.alertId ?? ''), by);
        }
      } catch (err) {
        log.warn('mensagem inválida do painel', { err });
      }
    });

    try {
      const [beds, alerts] = await Promise.all([storage.allSummaries(), storage.recentAlerts(100)]);
      ws.send(JSON.stringify({ type: 'snapshot', beds, alerts }));
    } catch (err) {
      log.error('falha ao montar snapshot do painel', { err });
    }
  });
}
