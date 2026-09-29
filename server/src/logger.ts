/**
 * Minimal structured (JSON lines) logger.
 *
 * Privacy rule: callers must never pass transcript text, Azure keys/tokens or
 * TURN credentials. Only identifiers, counts and error codes belong in logs.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = 'info';
let silent = false;

export function configureLogger(opts: { level?: Level; silent?: boolean }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.silent !== undefined) silent = opts.silent;
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (silent || order[level] < order[minLevel]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

/** Reduce an unknown error to a safe, content-free description. */
export function errorKind(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}
