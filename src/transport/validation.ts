/**
 * Validação das mensagens do protocolo de ingestão (sem dependências).
 * Valores fora de faixas fisiologicamente possíveis são rejeitados como artefato —
 * mas zero é aceito em FC/PAS/FR, pois pode representar parada cardiorrespiratória.
 */
import type { Consciousness, Spo2Scale, VitalSigns } from '../domain/types.js';

export type IngestMessage =
  | { type: 'hello'; bedId: string; label?: string; patient?: string; spo2Scale?: Spo2Scale }
  | { type: 'vitals'; reading: Omit<VitalSigns, 'spo2Scale'> & { spo2Scale?: Spo2Scale } }
  | { type: 'bye'; bedId: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; seq?: number };

const BED_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CONSCIOUSNESS = new Set<Consciousness>(['A', 'C', 'V', 'P', 'U']);
const RANGES = {
  hr: [0, 300], spo2: [0, 100], sbp: [0, 300], dbp: [0, 250], rr: [0, 80], temp: [25, 45],
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 120) => (typeof v === 'string' && v.length <= max ? v : undefined);

export function parseIngestMessage(raw: string, now: number, maxSkewMs: number): Parsed<IngestMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON inválido' };
  }
  if (!isObj(data)) return { ok: false, error: 'mensagem deve ser um objeto' };
  const seq = typeof data.seq === 'number' ? data.seq : undefined;
  const fail = (error: string): Parsed<IngestMessage> => ({ ok: false, error, seq });

  if (typeof data.bedId !== 'string' || !BED_ID.test(data.bedId)) return fail('bedId inválido');
  const bedId = data.bedId;

  switch (data.type) {
    case 'hello': {
      const scale = data.spo2Scale;
      if (scale !== undefined && scale !== 1 && scale !== 2) return fail('spo2Scale deve ser 1 ou 2');
      return {
        ok: true,
        value: { type: 'hello', bedId, label: str(data.label, 40), patient: str(data.patient), spo2Scale: scale as Spo2Scale | undefined },
      };
    }
    case 'bye':
      return { ok: true, value: { type: 'bye', bedId } };
    case 'vitals': {
      const values: Record<string, number> = {};
      for (const [k, [min, max]] of Object.entries(RANGES)) {
        const v = data[k];
        if (v === undefined && k === 'dbp') continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${k} ausente ou não numérico`);
        if (v < min || v > max) return fail(`${k}=${v} fora da faixa fisiológica [${min}, ${max}]`);
        values[k] = k === 'temp' ? Math.round(v * 10) / 10 : Math.round(v);
      }
      const consciousness = (data.consciousness ?? 'A') as Consciousness;
      if (!CONSCIOUSNESS.has(consciousness)) return fail('consciousness deve ser A, C, V, P ou U');
      const onOxygen = data.onOxygen ?? false;
      if (typeof onOxygen !== 'boolean') return fail('onOxygen deve ser booleano');
      const scale = data.spo2Scale;
      if (scale !== undefined && scale !== 1 && scale !== 2) return fail('spo2Scale deve ser 1 ou 2');
      let ts = typeof data.ts === 'number' ? data.ts : now;
      if (Math.abs(ts - now) > maxSkewMs) ts = now; // relógio do dispositivo não confiável
      return {
        ok: true,
        value: {
          type: 'vitals',
          reading: {
            bedId, ts, seq,
            hr: values.hr!, spo2: values.spo2!, sbp: values.sbp!, dbp: values.dbp, rr: values.rr!, temp: values.temp!,
            consciousness, onOxygen, spo2Scale: scale as Spo2Scale | undefined,
          },
        },
      };
    }
    default:
      return fail('type deve ser hello, vitals ou bye');
  }
}
