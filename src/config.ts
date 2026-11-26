import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from './domain/alert-policy.js';
import { DEFAULT_TREND_CONFIG, type TrendConfig } from './domain/trend.js';

const num = (name: string, def: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Variável ${name} inválida: "${raw}"`);
  return v;
};

export interface AppConfig {
  port: number;
  host: string;
  redisUrl?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  windowMs: number;
  sampleIntervalMs: number;
  signalTimeoutMs: number;
  watchdogIntervalMs: number;
  dashboardFlushMs: number;
  maxQueuePerBed: number;
  alertLogSize: number;
  maxClockSkewMs: number;
  policy: PolicyConfig;
  trend: TrendConfig;
}

export function loadConfig(): AppConfig {
  return {
    port: num('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    redisUrl: process.env.REDIS_URL || undefined,
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    windowMs: num('WINDOW_MS', 15 * 60_000),
    sampleIntervalMs: num('SAMPLE_INTERVAL_MS', 5_000),
    signalTimeoutMs: num('SIGNAL_TIMEOUT_MS', 15_000),
    watchdogIntervalMs: num('WATCHDOG_INTERVAL_MS', 5_000),
    dashboardFlushMs: num('DASHBOARD_FLUSH_MS', 1_000),
    maxQueuePerBed: num('MAX_QUEUE_PER_BED', 50),
    alertLogSize: num('ALERT_LOG_SIZE', 1_000),
    maxClockSkewMs: num('MAX_CLOCK_SKEW_MS', 30_000),
    policy: {
      ...DEFAULT_POLICY_CONFIG,
      confirmReadings: num('CONFIRM_READINGS', DEFAULT_POLICY_CONFIG.confirmReadings),
      deescalateAfterMs: num('DEESCALATE_AFTER_MS', DEFAULT_POLICY_CONFIG.deescalateAfterMs),
      ackSnoozeMs: num('ACK_SNOOZE_MS', DEFAULT_POLICY_CONFIG.ackSnoozeMs),
      renotifyMs: {
        CRITICAL: num('RENOTIFY_CRITICAL_MS', DEFAULT_POLICY_CONFIG.renotifyMs.CRITICAL),
        HIGH: num('RENOTIFY_HIGH_MS', DEFAULT_POLICY_CONFIG.renotifyMs.HIGH),
        MEDIUM: num('RENOTIFY_MEDIUM_MS', DEFAULT_POLICY_CONFIG.renotifyMs.MEDIUM),
      },
    },
    trend: {
      ...DEFAULT_TREND_CONFIG,
      minSpanMs: num('TREND_MIN_SPAN_MS', DEFAULT_TREND_CONFIG.minSpanMs),
    },
  };
}
