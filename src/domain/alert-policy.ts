/**
 * Política de alertas: decide QUANDO e COM QUAL PRIORIDADE notificar a enfermagem.
 *
 * Objetivo duplo: reagir rápido à piora e evitar fadiga de alarmes.
 *  - Escalonamento exige `confirmReadings` leituras consecutivas acima do nível atual
 *    (um artefato isolado — sensor solto — não dispara alerta).
 *  - Lembretes periódicos enquanto o alerta não for reconhecido.
 *  - Reconhecimento ("ack") silencia lembretes por `ackSnoozeMs`.
 *  - Desescalonamento só após `deescalateAfterMs` estável num nível mais baixo
 *    (histerese — evita alternância ALTA/MÉDIA a cada leitura).
 *
 * Função pura: (estado anterior, entrada) -> (novo estado, eventos).
 */
import { PARAMETER_LABEL } from './news2.js';
import {
  PRIORITY_RANK, priorityFromRank,
  type Alert, type BedState, type News2Parameter, type News2Result, type Priority, type TrendResult,
} from './types.js';

export interface PolicyConfig {
  confirmReadings: number;
  deescalateAfterMs: number;
  deescalateMinReadings: number;
  renotifyMs: Record<Exclude<Priority, 'NONE'>, number>;
  ackSnoozeMs: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  confirmReadings: 2,
  deescalateAfterMs: 60_000,
  deescalateMinReadings: 3,
  renotifyMs: { CRITICAL: 60_000, HIGH: 5 * 60_000, MEDIUM: 15 * 60_000 },
  ackSnoozeMs: 10 * 60_000,
};

export interface PolicyInput {
  bedId: string;
  now: number;
  news2: News2Result;
  trend?: TrendResult;
}

export interface PolicyOutput {
  state: BedState;
  alerts: Alert[];
  /** Prioridade calculada só para esta leitura (antes de confirmação/histerese). */
  target: Priority;
}

export type IdGenerator = () => string;

export function initialBedState(bedId: string, now: number): BedState {
  return { bedId, level: 'NONE', levelSince: now, lastNotifiedAt: 0, lastSampleTs: 0 };
}

/** Prioridade a partir do NEWS2, com reforço de um degrau por tendência de piora (teto: HIGH). */
export function targetPriority(news2: News2Result, trend?: TrendResult): Priority {
  const base: Priority =
    news2.risk === 'high' ? 'CRITICAL'
      : news2.risk === 'medium' ? 'HIGH'
        : news2.risk === 'low-medium' ? 'MEDIUM'
          : 'NONE';
  if (trend?.status !== 'deteriorating') return base;
  const boosted = Math.min(PRIORITY_RANK[base] + 1, PRIORITY_RANK.HIGH);
  return priorityFromRank(Math.max(PRIORITY_RANK[base], boosted));
}

export function describeReasons(news2: News2Result, trend?: TrendResult): string[] {
  const reasons = [`NEWS2 = ${news2.total}`];
  const red = (Object.entries(news2.subscores) as Array<[News2Parameter, number]>)
    .filter(([, s]) => s >= 3)
    .map(([p]) => PARAMETER_LABEL[p]);
  if (red.length) reasons.push(`Parâmetro com 3 pontos: ${red.join(', ')}`);
  if (trend?.status === 'deteriorating') reasons.push(...trend.reasons);
  return reasons;
}

const TITLE: Record<Exclude<Priority, 'NONE'>, string> = {
  CRITICAL: 'NEWS2 ≥ 7 (risco alto) — resposta de emergência',
  HIGH: 'NEWS2 5–6 (risco médio) — resposta urgente',
  MEDIUM: 'Atenção — reavaliar à beira-leito',
};

export function evaluate(
  prev: BedState,
  input: PolicyInput,
  cfg: PolicyConfig,
  newId: IdGenerator,
): PolicyOutput {
  const { now, news2, trend, bedId } = input;
  const target = targetPriority(news2, trend);
  const state: BedState = { ...prev, trend: trend ?? prev.trend };
  const alerts: Alert[] = [];
  const cur = PRIORITY_RANK[prev.level];
  const tgt = PRIORITY_RANK[target];

  const make = (kind: Alert['kind'], priority: Alert['priority'], title: string): Alert => ({
    id: newId(),
    bedId,
    kind,
    priority,
    title,
    reasons: describeReasons(news2, trend),
    news2: news2.total,
    recommendation: news2.recommendation,
    trend: trend?.status,
    createdAt: now,
  });

  if (tgt > cur) {
    // --- Possível escalonamento: aguarda confirmação ---
    delete state.lower;
    const pendingLevel = prev.pending && PRIORITY_RANK[prev.pending.level] > cur
      ? priorityFromRank(Math.min(PRIORITY_RANK[prev.pending.level], tgt))
      : target;
    const count = (prev.pending?.count ?? 0) + 1;
    if (count >= cfg.confirmReadings) {
      const level = pendingLevel as Exclude<Priority, 'NONE'>;
      const alert = make('ESCALATION', level, TITLE[level]);
      alerts.push(alert);
      Object.assign(state, {
        level, levelSince: now, lastNotifiedAt: now, activeAlertId: alert.id,
      });
      delete state.pending;
      delete state.acknowledgedAt;
      delete state.acknowledgedBy;
    } else {
      state.pending = { level: pendingLevel, count };
    }
    return { state, alerts, target };
  }

  delete state.pending;

  if (tgt === cur) {
    delete state.lower;
    if (prev.level !== 'NONE') {
      const level = prev.level;
      const since = prev.acknowledgedAt
        ? Math.max(prev.lastNotifiedAt, prev.acknowledgedAt + cfg.ackSnoozeMs - cfg.renotifyMs[level])
        : prev.lastNotifiedAt;
      if (now - since >= cfg.renotifyMs[level]) {
        const alert = make('REMINDER', level, `Lembrete: ${TITLE[level]}`);
        alert.id = prev.activeAlertId ?? alert.id; // mesmo episódio
        alerts.push(alert);
        state.lastNotifiedAt = now;
      }
    }
    return { state, alerts, target };
  }

  // --- tgt < cur: possível desescalonamento com histerese ---
  const lower = prev.lower
    ? {
      since: prev.lower.since,
      count: prev.lower.count + 1,
      level: priorityFromRank(Math.max(PRIORITY_RANK[prev.lower.level], tgt)),
    }
    : { since: now, count: 1, level: target };

  if (now - lower.since >= cfg.deescalateAfterMs && lower.count >= cfg.deescalateMinReadings) {
    const from = prev.level;
    const to = lower.level;
    const resolved = to === 'NONE';
    const alert = make(
      resolved ? 'RESOLVED' : 'DE_ESCALATION',
      'INFO',
      resolved ? `Parâmetros estabilizados (antes: ${from})` : `Prioridade reduzida de ${from} para ${to}`,
    );
    alerts.push(alert);
    Object.assign(state, { level: to, levelSince: now, lastNotifiedAt: now });
    if (resolved) delete state.activeAlertId;
    else state.activeAlertId = alert.id;
    delete state.lower;
    delete state.acknowledgedAt;
    delete state.acknowledgedBy;
  } else {
    state.lower = lower;
  }
  return { state, alerts, target };
}
