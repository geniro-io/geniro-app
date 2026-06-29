type Level = 'info' | 'warn' | 'error';

/**
 * Minimal structured logger. Writes JSON lines to STDERR so STDOUT stays clean
 * for the machine-readable readiness marker the shell parses on spawn.
 */
function emit(
  level: Level,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  process.stderr.write(`${line}\n`);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) =>
    emit('error', msg, extra),
};
