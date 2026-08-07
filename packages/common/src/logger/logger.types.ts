import type { DestinationStream, LevelWithSilent } from 'pino';

export type LogLevel = LevelWithSilent | 'system';

/** Local replacement for the former @sentry/core SeverityLevel. */
export type SeverityLevel =
  'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

export interface ILoggerParams {
  prettyPrint?: boolean;
  sentryDsn?: string;
  level?: LogLevel;
  environment: string;
  appName: string;
  appVersion: string;
  /**
   * Extra destinations every log line is ALSO written to, alongside the
   * console one this logger already owns.
   *
   * Additive by construction: absent (the default) leaves the single-stream
   * behaviour byte-for-byte as it was, so no existing caller changes. Present,
   * pino fans out through `multistream`.
   *
   * It exists because a log line that only ever reaches stdout is a log line an
   * app cannot show its user or write to disk. In geniro-app the daemon is a
   * CHILD of the Electron shell, and a packaged shell launched from Finder has
   * no stdout at all — so every line the daemon emitted was discarded in
   * exactly the build where a user would need it.
   */
  streams?: DestinationStream[];
}

export interface ISentryLogData {
  userId?: string;
  requestId?: string;
  operationId?: string;
  level?: SeverityLevel;
  errorCode?: string;
  statusCode?: number;
  message?: string;
  url?: string;
  [key: string]: unknown;
}

export const LoggerParams = Symbol('LoggerParams');
export const Logger = Symbol('Logger');
