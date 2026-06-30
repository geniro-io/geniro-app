import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as SqliteMikroOrm } from '@mikro-orm/sqlite';
import type { INestApplication } from '@nestjs/common';
import { AppBootstrapper } from '@packages/common';
import {
  buildHttpNestApp,
  HttpServerModule,
  type IHttpServerParams,
} from '@packages/http-server';
import { buildMetricExtension } from '@packages/metrics';
import { buildMikroOrmExtension } from '@packages/mikroorm';
import type { FastifyInstance } from 'fastify';

import { AppModule } from './app.module';
import type { RuntimeInfo } from './auth/runtime';
import mikroOrmConfig from './db/mikro-orm.config';
import { environment } from './environments';
import type { DaemonInfo } from './utils/handshake';
import { mintToken, removePidfile, writePidfile } from './utils/pidfile';
import { registerWebsocket } from './v1/notifications/gateways/ws';

/** Bind the preferred port on loopback, falling back to a free port if taken. */
async function listenLoopback(
  app: INestApplication,
  host: string,
  preferredPort: number,
): Promise<number> {
  try {
    await app.listen(preferredPort, host);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw err;
    }
    console.error('preferred port in use; falling back to a free port', {
      preferredPort,
    });
    await app.listen(0, host);
  }
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  const address = fastify.server.address() as AddressInfo | string | null;
  if (!address || typeof address === 'string') {
    throw new Error('daemon failed to resolve a listening port');
  }
  return address.port;
}

async function bootstrap(): Promise<void> {
  const startedAt = Date.now();
  const token = mintToken();
  const runtime: RuntimeInfo = {
    token,
    version: environment.version,
    startedAt,
  };

  // Loopback-only daemon: bind 127.0.0.1 ourselves. http-server's own
  // bootstrapper (runHttpApp) hardcodes 0.0.0.0, so we assemble via
  // AppBootstrapper + buildHttpNestApp and listen manually.
  const httpParams: IHttpServerParams = {
    port: environment.preferredPort,
    swagger: {},
    corsOrigin: '',
  };

  const bootstrapper = new AppBootstrapper({
    environment: environment.env,
    appName: environment.appName,
    appVersion: environment.version,
  });
  bootstrapper.addExtension({
    modules: [HttpServerModule.forRoot(httpParams)],
  });
  bootstrapper.addExtension(buildMikroOrmExtension(mikroOrmConfig));
  bootstrapper.addExtension(buildMetricExtension());
  bootstrapper.addModules([AppModule.forRoot({ runtime })]);
  bootstrapper.setupLogger({
    prettyPrint: environment.prettyLog,
    level: environment.logLevel,
  });

  const appModule = bootstrapper.buildModule();
  const app = await buildHttpNestApp(appModule, httpParams);

  // Migrate-on-launch: additively sync the SQLite schema from the entities.
  // `safe: true` never emits destructive DDL — a removed/renamed column won't
  // drop user data; the full versioned Migrator workflow lands in M2.
  const orm = app.get(MikroORM) as unknown as SqliteMikroOrm;
  await orm.schema.update({ safe: true });

  // WS transport on the underlying Fastify instance (loopback token-gated).
  await registerWebsocket(
    app.getHttpAdapter().getInstance() as FastifyInstance,
    runtime,
  );

  const port = await listenLoopback(
    app,
    environment.host,
    environment.preferredPort,
  );

  // Pidfile is written only after the schema is ready and the server listens —
  // a reader that sees the pidfile is guaranteed a healthy, migrated daemon.
  const info: DaemonInfo = {
    pid: process.pid,
    host: environment.host,
    port,
    token,
    version: environment.version,
    startedAt: new Date(startedAt).toISOString(),
  };
  writePidfile(environment.pidfilePath, info);

  console.error('daemon ready', { port, pid: process.pid });
  process.stdout.write(`GENIRO_DAEMON_READY ${JSON.stringify({ port })}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error('daemon shutting down', { signal });
    removePidfile(environment.pidfilePath);
    try {
      await app.close();
    } catch (err) {
      console.error('app close failed', { err: String(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  console.error('daemon failed to start', { err: String(err) });
  process.exit(1);
});
