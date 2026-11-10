export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** One JSON object per line on stdout. Callers must never pass secrets or raw tokens. */
export function createLogger(
  level: LogLevel,
  base: LogFields = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (RANK[lvl] < RANK[level]) return;
    write(JSON.stringify({ timestamp: new Date().toISOString(), level: lvl, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }, write),
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
