import type { FastifyCompressOptions } from '@fastify/compress';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type { SwaggerCustomOptions } from '@nestjs/swagger';
import type { IExceptionData, ISentryLogData } from '@packages/common';
import type helmet from 'helmet';

export interface IHttpServerParams {
  globalPrefix?: string;
  globalPrefixIgnore?: string[];
  swagger?: {
    options?: SwaggerCustomOptions;
    path?: string;
    description?: string;
    securitySchemas?: Record<string, unknown>;
  };
  apiDefaultVersion?: string;
  port?: number;
  /**
   * Host to bind. Defaults to `'0.0.0.0'` (all interfaces). Set a loopback
   * address (e.g. `'127.0.0.1'`) for a local-only server.
   */
  host?: string;
  /**
   * When the requested `port` is already in use (`EADDRINUSE`), retry on an
   * OS-assigned free port (`listen(0)`) instead of throwing. The actually-bound
   * port is reported via {@link IHttpServerParams.onListening}. Default `false`
   * (fail on conflict).
   */
  portFallback?: boolean;
  /**
   * Invoked once the server is listening, with the host and the actually-bound
   * port (which differs from `port` when {@link IHttpServerParams.portFallback}
   * kicked in). Use it to record the bound port — e.g. write a pidfile or print
   * a ready marker.
   */
  onListening?: (info: { host: string; port: number }) => void | Promise<void>;
  fastifyOptions?: ConstructorParameters<typeof FastifyAdapter>[0];
  helmetOptions?: Parameters<typeof helmet>[0];
  // compression with @fastify/compress
  compression?: FastifyCompressOptions;
  stripResponse?: boolean;
  /** Comma-separated allowed origins for CORS, or '*' for all. Empty string disables CORS. */
  corsOrigin?: string;
}

export interface IRequestBodySummary {
  type: string;
  size?: number;
  keysCount?: number;
  itemsCount?: number;
}

export interface IRequestData {
  userId?: string;
  requestId: string;
  ip: string;
  method: string;
  bodySummary?: IRequestBodySummary;
  url: string;
  [key: string]: unknown;
}

export interface ISentryExceptionData
  extends Partial<IRequestData>, IExceptionData {
  level: ISentryLogData['level'];
}

export enum HealthStatus {
  Ok = 'Ok',
  Failed = 'Failed',
}

export const HttpServerParams = Symbol('HttpServerParams');
export const HttpServerAuthParams = Symbol('HttpServerAuthParams');
