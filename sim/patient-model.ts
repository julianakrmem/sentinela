/**
 * Modelo fisiológico simplificado para SIMULAÇÃO. Cada paciente sintético tem um perfil
 * que define a evolução dos sinais vitais ao longo do tempo (com ruído gaussiano).
 * O tempo é comprimido: uma piora que levaria horas acontece em poucos minutos,
 * para que o painel e os testes de carga mostrem escalonamentos rapidamente.
 */
import type { Consciousness, Spo2Scale } from '../src/domain/types.js';
import type { Rng } from './synthetic.js';

export type Profile = 'stable' | 'sepsis' | 'respiratory' | 'copd' | 'recovering' | 'artifact';

export const PROFILE_MIX: Array<[Profile, number]> = [
  ['stable', 0.55], ['sepsis', 0.12], ['respiratory', 0.08],
  ['copd', 0.07], ['recovering', 0.1], ['artifact', 0.08],
];

export function pickProfile(rng: Rng): Profile {
  let r = rng.next();
  for (const [p, w] of PROFILE_MIX) { if ((r -= w) <= 0) return p; }
  return 'stable';
}

interface Baseline { hr: number; spo2: number; sbp: number; dbp: number; rr: number; temp: number }
type Delta = Partial<Baseline>;

export interface SimReading {
  hr: number; spo2: number; sbp: number; dbp: number; rr: number; temp: number;
  consciousness: Consciousness; onOxygen: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (p: number) => p * p * (3 - 2 * p);

export class SyntheticPatient {
  readonly spo2Scale: Spo2Scale;
  private readonly base: Baseline;
  private readonly onsetMs: number;
  private readonly rampMs: number;

  constructor(readonly profile: Profile, private readonly rng: Rng, timeScale = 1) {
    this.spo2Scale = profile === 'copd' ? 2 : 1;
    this.base = {
      hr: 66 + rng.gauss() * 7,
      spo2: profile === 'copd' ? 90 : 97.5 + rng.gauss() * 0.7,
      sbp: 124 + rng.gauss() * 9,
      dbp: 78 + rng.gauss() * 6,
      rr: profile === 'copd' ? 19 : 15 + rng.gauss() * 1.2,
      temp: 36.6 + rng.gauss() * 0.2,
    };
    if (profile === 'copd') this.base.hr += 10;
    this.onsetMs = rng.int(20_000, 90_000) / timeScale;
    this.rampMs = rng.int(120_000, 300_000) / timeScale;
  }

  private progress(t: number) {
    return smooth(clamp((t - this.onsetMs) / this.rampMs, 0, 1));
  }

  at(elapsedMs: number): SimReading {
    const p = this.progress(elapsedMs);
    let delta: Delta = {};
    let consciousness: Consciousness = 'A';
    let onOxygen = false;

    switch (this.profile) {
      case 'sepsis':
        delta = { hr: 46 * p, rr: 11 * p, temp: 2.3 * p, sbp: -40 * p, dbp: -22 * p, spo2: -4 * p };
        if (p > 0.85) consciousness = 'C';
        break;
      case 'respiratory':
        delta = { spo2: -11 * p, rr: 12 * p, hr: 28 * p, sbp: 8 * p };
        onOxygen = p > 0.6;
        break;
      case 'copd':
        onOxygen = true;
        break;
      case 'recovering': {
        const q = 1 - p;
        delta = { hr: 40 * q, rr: 9 * q, temp: 1.8 * q, sbp: -26 * q, dbp: -12 * q, spo2: -5 * q };
        onOxygen = q > 0.5;
        break;
      }
    }

    const n = (sd: number) => this.rng.gauss() * sd;
    const r: SimReading = {
      hr: Math.round(clamp(this.base.hr + (delta.hr ?? 0) + n(2.5), 20, 250)),
      spo2: Math.round(clamp(this.base.spo2 + (delta.spo2 ?? 0) + n(0.6), 50, 100)),
      sbp: Math.round(clamp(this.base.sbp + (delta.sbp ?? 0) + n(3), 50, 250)),
      dbp: Math.round(clamp(this.base.dbp + (delta.dbp ?? 0) + n(2), 30, 150)),
      rr: Math.round(clamp(this.base.rr + (delta.rr ?? 0) + n(0.8), 4, 60)),
      temp: Math.round(clamp(this.base.temp + (delta.temp ?? 0) + n(0.05), 33, 42) * 10) / 10,
      consciousness,
      onOxygen,
    };

    // Artefatos de sensor isolados (sonda de oxímetro solta, movimento): a política
    // de confirmação deve impedir que virem alerta.
    if (this.profile === 'artifact' && this.rng.next() < 0.03) {
      if (this.rng.next() < 0.6) r.spo2 = this.rng.int(55, 78);
      else r.hr = this.rng.int(165, 210);
    }
    return r;
  }
}
