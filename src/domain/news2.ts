/**
 * National Early Warning Score 2 (NEWS2) — Royal College of Physicians, 2017.
 * Implementação pura: recebe sinais vitais, devolve pontuação, subescores e risco.
 *
 * Referência das faixas: RCP. National Early Warning Score (NEWS) 2:
 * Standardising the assessment of acute-illness severity in the NHS. London: RCP, 2017.
 */
import type { ClinicalRisk, News2Parameter, News2Result, VitalSigns } from './types.js';

export function scoreRespiration(rr: number): number {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}

export function scoreSpo2Scale1(spo2: number): number {
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
}

/**
 * Escala 2: para pacientes com alvo de 88–92% (insuficiência respiratória hipercápnica).
 * Saturações altas só pontuam se o paciente estiver em oxigênio suplementar.
 */
export function scoreSpo2Scale2(spo2: number, onOxygen: boolean): number {
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  if (spo2 <= 92) return 0;
  if (!onOxygen) return 0;
  if (spo2 <= 94) return 1;
  if (spo2 <= 96) return 2;
  return 3;
}

export const scoreOxygen = (onOxygen: boolean): number => (onOxygen ? 2 : 0);

export function scoreSystolic(sbp: number): number {
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
}

export function scorePulse(hr: number): number {
  if (hr <= 40) return 3;
  if (hr <= 50) return 1;
  if (hr <= 90) return 0;
  if (hr <= 110) return 1;
  if (hr <= 130) return 2;
  return 3;
}

export const scoreConsciousness = (c: VitalSigns['consciousness']): number => (c === 'A' ? 0 : 3);

export function scoreTemperature(temp: number): number {
  if (temp <= 35.0) return 3;
  if (temp <= 36.0) return 1;
  if (temp <= 38.0) return 0;
  if (temp <= 39.0) return 1;
  return 2;
}

const RECOMMENDATION: Record<ClinicalRisk, (total: number) => string> = {
  low: (t) =>
    t === 0
      ? 'Monitorização mínima a cada 12 h.'
      : 'Avaliação pela enfermagem; reavaliar no mínimo a cada 4–6 h.',
  'low-medium': () =>
    'Parâmetro isolado com 3 pontos: resposta urgente na unidade e avaliação médica; reavaliar no mínimo a cada 1 h.',
  medium: () =>
    'Resposta urgente: avaliação por médico/equipe de resposta rápida; reavaliar no mínimo a cada 1 h.',
  high: () =>
    'Resposta de emergência: equipe com competência em cuidados críticos; monitorização contínua.',
};

export function computeNews2(v: Pick<VitalSigns,
  'rr' | 'spo2' | 'onOxygen' | 'spo2Scale' | 'sbp' | 'hr' | 'consciousness' | 'temp'>): News2Result {
  const subscores: Record<News2Parameter, number> = {
    respiration: scoreRespiration(v.rr),
    spo2: v.spo2Scale === 2 ? scoreSpo2Scale2(v.spo2, v.onOxygen) : scoreSpo2Scale1(v.spo2),
    oxygen: scoreOxygen(v.onOxygen),
    systolic: scoreSystolic(v.sbp),
    pulse: scorePulse(v.hr),
    consciousness: scoreConsciousness(v.consciousness),
    temperature: scoreTemperature(v.temp),
  };
  const total = Object.values(subscores).reduce((a, b) => a + b, 0);
  const redScore = Object.values(subscores).some((s) => s >= 3);

  let risk: ClinicalRisk;
  if (total >= 7) risk = 'high';
  else if (total >= 5) risk = 'medium';
  else if (redScore) risk = 'low-medium';
  else risk = 'low';

  return { total, subscores, redScore, risk, recommendation: RECOMMENDATION[risk](total) };
}

export const PARAMETER_LABEL: Record<News2Parameter, string> = {
  respiration: 'FR',
  spo2: 'SpO2',
  oxygen: 'O2 suplementar',
  systolic: 'PAS',
  pulse: 'FC',
  consciousness: 'Consciência',
  temperature: 'Temperatura',
};
