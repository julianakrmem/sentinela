/**
 * Tipos de domínio do motor de triagem.
 * Nenhum tipo aqui depende de infraestrutura (Redis, WebSocket, HTTP).
 */

/** Escala ACVPU: Alert, new Confusion, Voice, Pain, Unresponsive. */
export type Consciousness = 'A' | 'C' | 'V' | 'P' | 'U';

/** Escala de SpO2 do NEWS2: 1 = padrão; 2 = alvo 88–92% (ex.: DPOC com retenção de CO2). */
export type Spo2Scale = 1 | 2;

export interface VitalSigns {
  bedId: string;
  /** Timestamp informado pelo dispositivo (ms epoch). */
  ts: number;
  seq?: number;
  /** Frequência cardíaca (bpm). */
  hr: number;
  /** Saturação periférica de O2 (%). */
  spo2: number;
  /** Pressão arterial sistólica (mmHg). */
  sbp: number;
  /** Pressão arterial diastólica (mmHg) — exibida, não pontua no NEWS2. */
  dbp?: number;
  /** Frequência respiratória (irpm). */
  rr: number;
  /** Temperatura (°C). */
  temp: number;
  consciousness: Consciousness;
  onOxygen: boolean;
  spo2Scale: Spo2Scale;
}

export type News2Parameter =
  | 'respiration'
  | 'spo2'
  | 'oxygen'
  | 'systolic'
  | 'pulse'
  | 'consciousness'
  | 'temperature';

export type ClinicalRisk = 'low' | 'low-medium' | 'medium' | 'high';

export interface News2Result {
  total: number;
  subscores: Record<News2Parameter, number>;
  /** Algum parâmetro isolado pontuou 3 ("red score"). */
  redScore: boolean;
  risk: ClinicalRisk;
  recommendation: string;
}

/** Prioridade operacional do alerta para a enfermagem. */
export type Priority = 'NONE' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertPriority = Exclude<Priority, 'NONE'> | 'INFO';

export const PRIORITY_RANK: Record<Priority, number> = {
  NONE: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export const priorityFromRank = (rank: number): Priority =>
  (['NONE', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)[Math.max(0, Math.min(3, rank))]!;

/** Ponto compacto guardado na janela temporal. */
export interface TrendSample {
  ts: number;
  news2: number;
  hr: number;
  spo2: number;
  sbp: number;
  rr: number;
  temp: number;
}

export type TrendStatus = 'insufficient' | 'stable' | 'deteriorating' | 'improving';

export interface TrendResult {
  status: TrendStatus;
  samples: number;
  spanMs: number;
  baselineScore?: number;
  currentScore?: number;
  scoreDelta?: number;
  /** Inclinação da regressão linear do NEWS2, em pontos a cada 10 minutos. */
  slopePer10Min?: number;
  reasons: string[];
}

export type AlertKind =
  | 'ESCALATION'
  | 'REMINDER'
  | 'DE_ESCALATION'
  | 'RESOLVED'
  | 'SIGNAL_LOST'
  | 'SIGNAL_RESTORED';

export interface Alert {
  id: string;
  bedId: string;
  kind: AlertKind;
  priority: AlertPriority;
  title: string;
  reasons: string[];
  news2: number | null;
  recommendation?: string;
  trend?: TrendStatus;
  createdAt: number;
}

/** Estado persistido por leito (compartilhado entre instâncias via Redis). */
export interface BedState {
  bedId: string;
  level: Priority;
  levelSince: number;
  lastNotifiedAt: number;
  activeAlertId?: string;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  /** Leituras consecutivas acima do nível atual, aguardando confirmação. */
  pending?: { level: Priority; count: number };
  /** Leituras abaixo do nível atual, aguardando tempo mínimo para desescalar. */
  lower?: { level: Priority; since: number; count: number };
  lastSampleTs: number;
  trend?: TrendResult;
  signalLost?: boolean;
}

/** Resumo do leito exibido no painel de enfermagem. */
export interface BedSummary {
  bedId: string;
  label: string;
  patient?: string;
  updatedAt: number;
  vitals: Omit<VitalSigns, 'bedId' | 'seq'>;
  news2: number;
  subscores: Record<News2Parameter, number>;
  risk: ClinicalRisk;
  priority: Priority;
  trend: TrendStatus;
  acknowledged: boolean;
  activeAlertId?: string;
  signalLost: boolean;
}

export type TriageEvent =
  | { type: 'alert'; alert: Alert }
  | { type: 'ack'; bedId: string; alertId: string; by: string; at: number }
  | { type: 'discharge'; bedId: string };
