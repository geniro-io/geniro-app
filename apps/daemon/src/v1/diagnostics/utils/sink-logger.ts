import { ConsoleLogger, type LogLevel as NestLogLevel } from '@nestjs/common';

import type { DebugLevel } from '../diagnostics.types';
import { debugSink } from './debug-sink';

/**
 * A Nest logger that records into {@link debugSink} on its way to the console.
 *
 * Installed with `Logger.overrideLogger` in `main.ts`, which is what makes it
 * reach the lines that matter most. The daemon has TWO logging paths, and only
 * one of them was ever going anywhere:
 *
 * - the vendored pino logger, injected under `@packages/common`'s `Logger`
 *   token — the JSON lines, already teed into the sink by the pino stream;
 * - `new Logger(SomeService.name)` from `@nestjs/common`, which is what nearly
 *   every service in this daemon actually uses, PLUS Nest's own internals
 *   (`InstanceLoader`, `RouterExplorer`, and — the one that matters —
 *   `ExceptionHandler`, which is where a failed boot reports why).
 *
 * The second path went to the console and nowhere else, so a packaged app
 * launched from Finder discarded every line of it. Measured on a real boot:
 * the log file held 8 entries, none of which were the reason the daemon had
 * just refused to start.
 *
 * It EXTENDS ConsoleLogger rather than replacing it, so the terminal output
 * under `pnpm dev` stays byte-for-byte what it was — this only adds a second
 * destination.
 */
export class SinkLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    this.capture('info', message, rest);
    super.log(message as string, ...(rest as string[]));
  }

  override error(message: unknown, ...rest: unknown[]): void {
    this.capture('error', message, rest);
    super.error(message as string, ...(rest as string[]));
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    this.capture('warn', message, rest);
    super.warn(message as string, ...(rest as string[]));
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    this.capture('debug', message, rest);
    super.debug(message as string, ...(rest as string[]));
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    this.capture('trace', message, rest);
    super.verbose(message as string, ...(rest as string[]));
  }

  override fatal(message: unknown, ...rest: unknown[]): void {
    // No `fatal` in the debug vocabulary: a reader filtering for problems
    // wants one bucket, and a level nothing else ever emits would be a filter
    // that is empty on every normal day.
    this.capture('error', message, rest);
    super.fatal(message as string, ...(rest as string[]));
  }

  /**
   * Nest's call shape is `(message, ...params, context?)` — the context is the
   * LAST argument when it is a string, and an error's stack is a string param
   * too. Both are kept: the context becomes the entry's `context.source`
   * (which is what a reader filters by) and everything else is appended to the
   * message, because a stack trace with its first line missing is not a stack
   * trace.
   */
  private capture(level: DebugLevel, message: unknown, rest: unknown[]): void {
    try {
      const params = [...rest];
      const source =
        params.length > 0 && typeof params[params.length - 1] === 'string'
          ? (params.pop() as string)
          : undefined;
      const parts = [text(message), ...params.map(text)].filter(
        (part) => part.length > 0,
      );
      debugSink.record(
        'daemon',
        level,
        parts.join(' '),
        source ? { source } : null,
      );
    } catch {
      // A logger that can throw is a logger that takes the app down over a
      // diagnostic. Console output above is unaffected either way.
    }
  }
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The Nest levels this logger should emit, derived from the daemon's own. */
export function nestLevelsFor(level: string): NestLogLevel[] {
  const order: NestLogLevel[] = [
    'verbose',
    'debug',
    'log',
    'warn',
    'error',
    'fatal',
  ];
  const from: Record<string, NestLogLevel> = {
    trace: 'verbose',
    debug: 'debug',
    info: 'log',
    warn: 'warn',
    error: 'error',
    fatal: 'fatal',
  };
  const floor = from[level] ?? 'log';
  return order.slice(order.indexOf(floor));
}
