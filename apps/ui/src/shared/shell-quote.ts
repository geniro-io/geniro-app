/**
 * One argument as a POSIX shell must be given it to read it back as that same
 * argument: anything outside a plain-word allowlist is single-quoted. The one
 * rule for every place the app writes or shows a command line, so what a
 * dialog shows is what a terminal would run.
 *
 * TWIN PARSER: apps/daemon/src/v1/handoff/utils/shell-line.ts (the daemon's
 * copy; the two processes share no code).
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && value.length > 0
    ? value
    : `'${value.split("'").join(`'\\''`)}'`;
}
