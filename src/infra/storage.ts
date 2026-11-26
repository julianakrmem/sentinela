/**
 * Porta de armazenamento/mensageria. O domínio e a aplicação dependem apenas
 * desta interface; Redis e memória são adaptadores intercambiáveis (ver ADR-0002).
 */
import type { Alert, BedState, BedSummary, TrendSample, TriageEvent } from '../domain/types.js';

export interface SaveOptions {
  /** Atualiza o "último sinal recebido" usado pelo watchdog de perda de sinal. */
  touchLastSeen?: number;
}

export interface Storage {
  readonly kind: 'redis' | 'memory';

  getBedState(bedId: string): Promise<BedState | null>;
  /** Persiste estado + resumo do painel e publica a atualização do leito (atômico no Redis). */
  saveBed(state: BedState, summary: BedSummary, opts?: SaveOptions): Promise<void>;

  /** Acrescenta amostra à janela deslizante, poda o que saiu da janela e devolve a janela inteira. */
  appendSample(bedId: string, sample: TrendSample, windowMs: number): Promise<TrendSample[]>;

  /** Grava o alerta no log (stream) e publica o evento em tempo real. */
  publishEvent(event: TriageEvent): Promise<void>;
  recentAlerts(limit: number): Promise<Array<Alert & { ack?: { by: string; at: number } }>>;

  allSummaries(): Promise<BedSummary[]>;
  getSummary(bedId: string): Promise<BedSummary | null>;
  /** Leitos cujo último sinal é anterior a `before` (ms epoch). */
  staleBeds(before: number): Promise<string[]>;
  forgetLastSeen(bedId: string): Promise<void>;
  removeBed(bedId: string): Promise<void>;

  onEvent(handler: (e: TriageEvent) => void): Promise<void>;
  onBedUpdate(handler: (s: BedSummary) => void): Promise<void>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}
