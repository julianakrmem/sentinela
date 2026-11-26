/**
 * Logger estruturado em JSON (uma linha por evento, pronto para Loki/ELK/CloudWatch).
 * Sem dependências: formato compatível com o do pino (level, time, msg, campos extras).
 *
 * Regra de privacidade: logs nunca recebem nome de paciente nem sinais vitais brutos —
 * apenas identificadores de leito, escores e metadados operacionais.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serializeError(e: unknown) {
  if (e instanceof Error) return { type: e.name, message: e.message, stack: e.stack };
  return e;
}

export function createLogger(
  opts: { level?: Level; base?: Record<string, unknown>; write?: (line: string) => void } = {},
): Logger {
  const min = RANK[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const base = opts.base ?? {};

  const log = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (RANK[level] < min) return;
    const entry: Record<string, unknown> = { level, time: new Date().toISOString(), ...base, msg };
    for (const [k, v] of Object.entries(fields)) entry[k] = k === 'err' ? serializeError(v) : v;
    write(JSON.stringify(entry));
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) => createLogger({ ...opts, base: { ...base, ...b } }),
  };
}

export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};
