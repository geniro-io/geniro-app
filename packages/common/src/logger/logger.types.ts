import type { LevelWithSilent } from 'pino';

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
