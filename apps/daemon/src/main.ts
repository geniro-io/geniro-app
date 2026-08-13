import 'reflect-metadata';

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as SqliteMikroOrm } from '@mikro-orm/sqlite';
import { type INestApplication, Logger } from '@nestjs/common';
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
import { installCrashGuards } from './utils/crash-guards';
import { type DaemonInfo, stampEntry } from './utils/handshake';
import {
  acquireInstanceLock,
  DAEMON_LOCK_FILE_NAME,
  DaemonAlreadyRunningError,
} from './utils/instance-lock';
import { writePidfile } from './utils/pidfile';
import { ClaudeAdapter } from './v1/agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from './v1/agents/adapters/cursor-acp/cursor-acp.adapter';
import { ChatService } from './v1/agents/services/chat.service';
import { StrandedChildReaper } from './v1/agents/services/stranded-child-reaper.service';
import {
  CHILD_JOURNAL_FILE_NAME,
  configureChildJournal,
} from './v1/agents/utils/child-journal';
import {
  configureDebugSink,
  DEBUG_LOG_DIR_NAME,
} from './v1/diagnostics/utils/debug-sink';
import { createPinoSinkStream } from './v1/diagnostics/utils/pino-sink-stream';
import { registerSecret } from './v1/diagnostics/utils/redact';
import { SinkLogger } from './v1/diagnostics/utils/sink-logger';
import { GraphExecutorService } from './v1/graphs/services/graph-executor.service';

installCrashGuards();

const startedAt = Date.now();
const token = mintToken();

// BEFORE the bootstrapper, and before the token can reach a log line.
//
// The sink has to exist ahead of Nest because the lines worth having when a
// launch goes wrong — the instance lock, the schema sync, the stranded-child
// reap — are all emitted before the first injectable exists. And the launch
// token is registered here, one statement after it is minted, so there is no
// window in which it could be written to a file unredacted.
//
// The Cursor key is registered on the same rule, but it is no longer geniro's:
// the Keychain entry and the `GENIRO_CURSOR_API_KEY` hop are gone, because
// cursor-agent authenticates from its own `~/.cursor` login. What can still be
// here is a key the USER exported in the shell that launched the app, which
// `CursorAcpAdapter.buildEnv` hands to its child — so it is a live credential
// this process holds and must not write out. Absent is the normal case, and
// `registerSecret` ignores an undefined value.
configureDebugSink({
  dir: join(environment.userDataDir, DEBUG_LOG_DIR_NAME),
});
registerSecret(token, 'launch token');
registerSecret(process.env.CURSOR_API_KEY, 'cursor api key');

// The daemon logs down TWO paths and only one of them was going anywhere. The
// vendored pino logger is teed by `createPinoSinkStream` below; everything
// using `new Logger(X)` from @nestjs/common — nearly every service here, plus
// Nest's own InstanceLoader/RouterExplorer/ExceptionHandler — went to the
// console alone. This captures that second path, which is the one that says
// WHY a boot failed. Console output is unchanged: SinkLogger extends
// ConsoleLogger and only adds a destination.
Logger.overrideLogger(new SinkLogger());
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
          // `process.argv[1]` and not the resolved module path: it is the file
          // the supervisor named on the command line, so it is the same string
          // the supervisor will stamp when deciding whether this daemon is its
          // own current build.
          entry: stampEntry(process.argv[1] ?? '', statSync),
          pidStartedAtMs: Math.round(Date.now() - process.uptime() * 1000),
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
      // FIRST, ahead of every other reconcile: a previous launch's SIGKILL
      // leaves detached agent groups reparented to launchd, still holding the
      // session files the reconciles below are about to reason over. Kill them
      // before this launch can resume any of those sessions — and before the
      // server listens, so no new turn can race the sweep.
      app.get(StrandedChildReaper).reap();

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
      // Same hygiene, same reason, for the per-turn cursor config directories:
      // a SIGKILLed daemon skips every disposer, and each leftover is ~700KB of
      // the CLI's own cache.
      app.get(CursorAcpAdapter).sweepStaleProfiles();

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
  // Everything the daemon logs ALSO lands in the debug sink — the ring the
  // panel reads and the file under `<userData>/logs`. Without this the daemon
  // only ever wrote to stdout, which in a packaged app launched from Finder
  // goes nowhere: every line was discarded in exactly the build where a user
  // would need it.
  streams: [createPinoSinkStream()],
});
bootstrapper.addModules([AppModule.forRoot({ runtime })]);

/**
 * Boot: claim the userData dir, start recording spawned child groups, then hand
 * over to the bootstrapper.
 *
 * The lock comes FIRST, ahead of the journal and of Nest. Everything below it
 * assumes a single writer — the SQLite file, the pidfile, the child journal —
 * so a second daemon must be turned away before it can touch any of them, not
 * after. It is also why the journal is configured here rather than at module
 * scope: a launch that stands down must not have written anything.
 */
acquireInstanceLock(join(environment.userDataDir, DAEMON_LOCK_FILE_NAME))
  .then(async (releaseLock) => {
    // Backstop only, for the failures BELOW that exit before Nest exists. The
    // clean-shutdown release is `InstanceLockLifecycle`: Nest re-raises the
    // signal after its hooks, and default signal termination never runs `exit`
    // listeners, so this one does not fire on a normal stop.
    process.on('exit', releaseLock);

    // Every detached child group is written here the moment it exists, so a
    // SIGKILL that skips Nest's shutdown hooks still leaves a record for the
    // next launch to reap. Unconfigured, `trackDetachedChild` is a no-op.
    configureChildJournal(
      join(environment.userDataDir, CHILD_JOURNAL_FILE_NAME),
      new Logger('ChildJournal'),
    );

    await bootstrapper.init();
  })
  .catch((err: unknown) => {
    if (err instanceof DaemonAlreadyRunningError) {
      // Not a crash: the app already has a daemon. Say so plainly rather than
      // burying it in a stack trace — this is the message a developer sees
      // when `pnpm daemon:dev` meets a running app.
      console.error(err.message);
      process.exit(1);
    }
    console.error('daemon failed to start', { err: String(err) });
    process.exit(1);
  });
