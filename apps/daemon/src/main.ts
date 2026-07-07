import 'reflect-metadata';

import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as SqliteMikroOrm } from '@mikro-orm/sqlite';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { buildBootstrapper } from '@packages/common';
import { buildHttpServerExtension } from '@packages/http-server';
import { buildMetricExtension } from '@packages/metrics';
import { buildMikroOrmExtension } from '@packages/mikroorm';

import { AppModule } from './app.module';
import { mintToken } from './auth/mint-token';
import type { RuntimeInfo } from './auth/runtime';
import mikroOrmConfig from './db/mikro-orm.config';
import { environment } from './environments';
import type { DaemonInfo } from './utils/handshake';
import { writePidfile } from './utils/pidfile';
import { ClaudeAdapter } from './v1/agents/adapters/claude/claude.adapter';
import { ChatService } from './v1/agents/services/chat.service';
import { CursorMcpMergeService } from './v1/agents/services/cursor-mcp-merge.service';
import { GraphExecutorService } from './v1/graphs/services/graph-executor.service';

const startedAt = Date.now();
const token = mintToken();
const runtime: RuntimeInfo = {
  token,
  version: environment.version,
  startedAt,
  port: null,
};

// Assembled exactly like Geniro's apps/api: a bootstrapper + extensions, started
// via `init()`. The local-first specifics — bind 127.0.0.1 (never a routable
// address), negotiate a free port if the preferred one is taken, and write the
// pidfile only after a healthy listen — ride on the http-server extension's
// `host` / `portFallback` / `onListening` options instead of a hand-rolled
// bootstrap. Shutdown is Nest-owned (enableShutdownHooks); PidfileLifecycle
// clears the pidfile on the way out, so main.ts needs no signal handling.
const bootstrapper = buildBootstrapper({
  environment: environment.env,
  appName: environment.appName,
  appVersion: environment.version,
});

bootstrapper.addExtension(
  buildHttpServerExtension(
    {
      port: environment.preferredPort,
      host: environment.host,
      portFallback: true,
      swagger: {},
      // Allow the renderer (file://, or the electron-vite dev origin) to call
      // the loopback REST API directly. Safe here: the daemon binds 127.0.0.1
      // only and every non-public route is token-gated — same posture as the
      // WS gateway's `cors.origin: '*'`. The bearer token, not the origin, is
      // the gate.
      corsOrigin: '*',
      onListening: ({ host, port }) => {
        // Written only after the schema is migrated (appChangeCb) and the server
        // is listening — a reader that sees the pidfile is guaranteed a healthy,
        // migrated daemon. `port` is the actually-bound one (may differ from the
        // preferred port when portFallback kicked in). The shared RuntimeInfo
        // learns it here — the executor mints per-run MCP URLs from it.
        runtime.port = port;
        const info: DaemonInfo = {
          pid: process.pid,
          host,
          port,
          token,
          version: environment.version,
          startedAt: new Date(startedAt).toISOString(),
        };
        writePidfile(environment.pidfilePath, info);
        process.stdout.write(
          `GENIRO_DAEMON_READY ${JSON.stringify({ port })}\n`,
        );
      },
    },
    async (app: INestApplication) => {
      // Migrate-on-launch: additively sync the SQLite schema from the entities
      // before the server accepts traffic. `safe: true` never emits destructive
      // DDL — a removed/renamed column won't drop user data; the full versioned
      // Migrator workflow lands in M2.
      const orm = app.get(MikroORM) as unknown as SqliteMikroOrm;
      await orm.schema.update({ safe: true });

      // Reconcile chat runs left `running` by a prior crash / SIGKILL. Runs HERE
      // (after the schema sync, before listen) — not via an OnApplicationBootstrap
      // hook, which fires before this sync and would hit not-yet-created tables on
      // a fresh install, so a logged reconcile error always means a real failure.
      await app.get(ChatService).reconcileOrphanedRuns();
      await app.get(GraphExecutorService).reconcileOrphanedRuns();

      // Sweep MCP config files a prior crash left behind (the per-turn
      // disposer only runs on a clean settle). The tokens in them are already
      // dead — this is hygiene for <userData>/tmp.
      app.get(ClaudeAdapter).sweepStaleConfigs();

      // Restore .cursor/mcp.json merges a crash stranded in USER worktrees —
      // journal-driven, so no disk scanning; unlike the claude sweep this one
      // is an obligation, not hygiene (the file is the user's).
      app.get(CursorMcpMergeService).reconcileStranded();

      // Socket.IO transport for the renderer ⇄ daemon channel (token-gated in
      // NotificationsGateway), mirroring how Geniro's apps/api installs its
      // IoAdapter here — set before listen so the gateway binds to it.
      app.useWebSocketAdapter(new IoAdapter(app));

      return app;
    },
  ),
);

bootstrapper.addExtension(buildMikroOrmExtension(mikroOrmConfig));
bootstrapper.addExtension(buildMetricExtension());
bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel,
});
bootstrapper.addModules([AppModule.forRoot({ runtime })]);

bootstrapper.init().catch((err: unknown) => {
  console.error('daemon failed to start', { err: String(err) });
  process.exit(1);
});
