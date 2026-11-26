/**
 * Análise de tendência sobre a janela temporal recente de um leito.
 *
 * Estratégia (robusta a artefatos isolados):
 *  - linha de base = mediana do primeiro quarto da janela;
 *  - valor atual  = mediana das 3 últimas amostras;
 *  - inclinação   = regressão linear (mínimos quadrados) do NEWS2 no tempo.
 *
 * "Piora" = NEWS2 subiu >= scoreRise com inclinação positiva, OU queda de SpO2
 * relevante, OU pelo menos dois sinais vitais com deriva desfavorável.
 */
import type { TrendResult, TrendSample } from './types.js';

export interface TrendConfig {
  minSamples: number;
  minSpanMs: number;
  scoreRise: number;
  spo2Drop: number;
  hrRise: number;
  sbpDrop: number;
  rrRise: number;
}

export const DEFAULT_TREND_CONFIG: TrendConfig = {
  minSamples: 6,
  minSpanMs: 60_000,
  scoreRise: 2,
  spo2Drop: 4,
  hrRise: 20,
  sbpDrop: 20,
  rrRise: 6,
};

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Inclinação em unidades por ms. */
export function linearSlope(points: Array<[x: number, y: number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const x0 = points[0]![0];
  for (const [xr, y] of points) {
    const x = xr - x0;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

const fmtMin = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

export function analyzeTrend(window: TrendSample[], cfg: TrendConfig = DEFAULT_TREND_CONFIG): TrendResult {
  const samples = window.length;
  const spanMs = samples > 1 ? window[samples - 1]!.ts - window[0]!.ts : 0;
  if (samples < cfg.minSamples || spanMs < cfg.minSpanMs) {
    return { status: 'insufficient', samples, spanMs, reasons: [] };
  }

  const head = window.slice(0, Math.max(3, Math.floor(samples / 4)));
  const tail = window.slice(-3);
  const base = (k: keyof TrendSample) => median(head.map((s) => s[k]));
  const curr = (k: keyof TrendSample) => median(tail.map((s) => s[k]));

  const baselineScore = base('news2');
  const currentScore = curr('news2');
  const scoreDelta = currentScore - baselineScore;
  const slopePer10Min = linearSlope(window.map((s) => [s.ts, s.news2])) * 600_000;
  const span = fmtMin(spanMs);

  const reasons: string[] = [];
  const scoreWorse = scoreDelta >= cfg.scoreRise && slopePer10Min > 0;
  if (scoreWorse) reasons.push(`NEWS2 subiu de ${baselineScore} para ${currentScore} em ${span}`);

  const spo2Drop = base('spo2') - curr('spo2');
  const spo2Worse = spo2Drop >= cfg.spo2Drop;
  if (spo2Worse) reasons.push(`SpO2 caiu ${spo2Drop.toFixed(0)} pontos em ${span}`);

  const vitalFlags: string[] = [];
  const hrRise = curr('hr') - base('hr');
  if (hrRise >= cfg.hrRise) vitalFlags.push(`FC +${hrRise.toFixed(0)} bpm`);
  const sbpDrop = base('sbp') - curr('sbp');
  if (sbpDrop >= cfg.sbpDrop) vitalFlags.push(`PAS −${sbpDrop.toFixed(0)} mmHg`);
  const rrRise = curr('rr') - base('rr');
  if (rrRise >= cfg.rrRise) vitalFlags.push(`FR +${rrRise.toFixed(0)} irpm`);
  const multiVitalWorse = vitalFlags.length >= 2;
  if (multiVitalWorse) reasons.push(`Deriva combinada em ${span}: ${vitalFlags.join(', ')}`);

  let status: TrendResult['status'] = 'stable';
  if (scoreWorse || spo2Worse || multiVitalWorse) status = 'deteriorating';
  else if (scoreDelta <= -cfg.scoreRise && slopePer10Min < 0) status = 'improving';

  return {
    status,
    samples,
    spanMs,
    baselineScore,
    currentScore,
    scoreDelta,
    slopePer10Min: Math.round(slopePer10Min * 100) / 100,
    reasons,
  };
}
