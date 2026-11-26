/**
 * Gateway WebSocket de ingestão (/ws/ingest).
 *
 * Protocolo (JSON por mensagem):
 *   -> {"type":"hello","bedId":"UTI-01","label":"UTI 01","patient":"Nome sintético","spo2Scale":1}
 *   -> {"type":"vitals","bedId":"UTI-01","seq":1,"ts":...,"hr":88,"spo2":96,"sbp":120,"dbp":78,
 *       "rr":16,"temp":36.8,"consciousness":"A","onOxygen":false}
 *   <- {"type":"ack","bedId":"UTI-01","seq":1,"news2":0,"priority":"NONE"}
 *   <- {"type":"error","seq":1,"error":"..."}
 *   -> {"type":"bye","bedId":"UTI-01"}   (alta / desligamento intencional)
 *
 * Uma conexão pode carregar vários leitos (central de monitorização) ou um só.
 */
import type { WebSocket, WebSocketServer } from 'ws';
import type { Spo2Scale } from '../domain/types.js';
import { BackpressureError } from '../app/keyed-queue.js';
import type { TriageService } from '../app/triage-service.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { parseIngestMessage } from './validation.js';

interface Conn extends WebSocket { isAlive?: boolean }

export function attachIngestGateway(
  wss: WebSocketServer,
  deps: { service: TriageService; metrics: Metrics; log: Logger; maxClockSkewMs: number },
) {
  const { service, metrics, log } = deps;

  wss.on('connection', (ws: Conn, req) => {
    const beds = new Map<string, { spo2Scale: Spo2Scale }>();
    const remote = req.socket.remoteAddress;
    ws.isAlive = true;
    metrics.ingestConnections.inc();
    log.debug('monitor conectado', { remote });

    const send = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      const parsed = parseIngestMessage(data.toString(), Date.now(), deps.maxClockSkewMs);
      if (!parsed.ok) {
        metrics.rejected.inc({ reason: 'validation' });
        send({ type: 'error', seq: parsed.seq, error: parsed.error });
        return;
      }
      const msg = parsed.value;
      try {
        if (msg.type === 'hello') {
          beds.set(msg.bedId, { spo2Scale: msg.spo2Scale ?? 1 });
          service.registerBed(msg.bedId, { label: msg.label, patient: msg.patient });
          send({ type: 'welcome', bedId: msg.bedId });
        } else if (msg.type === 'bye') {
          beds.delete(msg.bedId);
          await service.discharge(msg.bedId);
          send({ type: 'bye', bedId: msg.bedId });
        } else {
          const r = msg.reading;
          const spo2Scale = r.spo2Scale ?? beds.get(r.bedId)?.spo2Scale ?? 1;
          const result = await service.ingest({ ...r, spo2Scale });
          send({ type: 'ack', bedId: r.bedId, seq: r.seq, news2: result.news2, priority: result.priority });
        }
      } catch (err) {
        if (err instanceof BackpressureError) {
          metrics.rejected.inc({ reason: 'backpressure' });
          send({ type: 'error', seq: msg.type === 'vitals' ? msg.reading.seq : undefined, error: err.message });
        } else {
          metrics.rejected.inc({ reason: 'internal' });
          log.error('falha ao processar mensagem', { err, type: msg.type });
          send({ type: 'error', error: 'erro interno' });
        }
      }
    });

    ws.on('close', () => {
      metrics.ingestConnections.dec();
      // Sem "bye": o watchdog decidirá se é perda de sinal.
      log.debug('monitor desconectado', { remote, beds: beds.size });
    });
    ws.on('error', (err) => log.warn('erro no socket de ingestão', { err }));
  });

  // Heartbeat: derruba conexões mortas (cabo/rede caiu sem FIN).
  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<Conn>) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
}
