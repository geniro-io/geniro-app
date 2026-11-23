import { type ChildProcess, spawn } from 'node:child_process';
import { extname, join } from 'node:path';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import { environment } from '../../../environments';
import { buildChildEnv } from '../../agents/utils/child-env';
import { trackDetachedChild } from '../../agents/utils/child-journal';
import {
  createGroupTerminator,
  type GroupTerminator,
} from '../../agents/utils/kill-tree';
import {
  EMBEDDING_GIVE_UP_MS,
  EMBEDDING_IDLE_UNLOAD_MS,
  EMBEDDING_RESTART_DELAYS_MS,
  type EmbeddingModelRef,
  type WorkerMessage,
  type WorkerOp,
  type WorkerRequest,
  type WorkerRequestOf,
  type WorkerResults,
} from '../embeddings.types';

export const EMBEDDING_WORKER_LAUNCH = Symbol('EMBEDDING_WORKER_LAUNCH');

/** How the child is started; a spec swaps in a fake worker script. */
export interface EmbeddingWorkerLaunch {
  command: string;
  args: string[];
  dbPath: string;
  idleUnloadMs?: number;
}

const STOP_GRACE_MS = 2_000;

export class EmbeddingUnavailableError extends Error {}

export function defaultWorkerLaunch(): EmbeddingWorkerLaunch {
  const entry = join(
    __dirname,
    '..',
    'worker',
    `embedding-worker${extname(__filename)}`,
  );
  const inherited = process.execArgv.filter(
    (arg) => !arg.startsWith('--inspect'),
  );
  return {
    command: process.execPath,
    args: [...inherited, entry],
    dbPath: join(environment.userDataDir, 'embeddings.db'),
  };
}

/** Requests whose success shows the child does real work, not only that it started. */
const WORK_OPS: ReadonlySet<WorkerOp> = new Set([
  'index',
  'indexChats',
  'score',
  'searchChats',
]);

interface PendingRequest {
  op: WorkerOp;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Running {
  child: ChildProcess;
  terminator: GroupTerminator;
  ready: Promise<void>;
  stopping: boolean;
}

export type EmbeddingProcessEvent =
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'crashed'; reason: string; restartInMs: number };

/**
 * Owns the one embedding child, like `AgentSessionRegistry` owns kept CLI
 * processes: journaled, closed on shutdown, and deliberately NOT in
 * `ProcessRegistry`, whose `activeCount` would keep the daemon from its idle
 * exit and from compacting the database while the child sits idle.
 */
@Injectable()
export class EmbeddingProcessService implements OnApplicationShutdown {
  private readonly logger = new Logger(EmbeddingProcessService.name);
  private readonly launch: EmbeddingWorkerLaunch;
  private readonly events = new Subject<EmbeddingProcessEvent>();
  private readonly pending = new Map<number, PendingRequest>();
  private running: Running | null = null;
  private nextId = 1;
  private models: {
    active: EmbeddingModelRef | null;
    pending: EmbeddingModelRef | null;
  } = {
    active: null,
    pending: null,
  };
  private failures = 0;
  private downUntil = 0;
  private lastFailure: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    @Optional()
    @Inject(EMBEDDING_WORKER_LAUNCH)
    launch?: EmbeddingWorkerLaunch,
  ) {
    this.launch = launch ?? defaultWorkerLaunch();
  }

  get dbPath(): string {
    return this.launch.dbPath;
  }

  get pid(): number | null {
    return this.running?.child.pid ?? null;
  }

  get alive(): boolean {
    return this.running !== null && !this.running.stopping;
  }

  get failure(): string | null {
    return Date.now() < this.downUntil ? this.lastFailure : null;
  }

  changes(): Observable<EmbeddingProcessEvent> {
    return this.events.asObservable();
  }

  /** The models later requests run against; sent to a running child at once. */
  async setModels(
    active: EmbeddingModelRef | null,
    pending: EmbeddingModelRef | null,
  ): Promise<void> {
    this.models = { active, pending };
    if (this.alive) {
      await this.request({ op: 'models', active, pending }, 30_000);
    }
  }

  /** A config push forgives earlier crashes: the next request may start the child again. */
  forgiveFailures(): void {
    this.failures = 0;
    this.downUntil = 0;
    this.lastFailure = null;
  }

  async request<Op extends WorkerOp>(
    request: WorkerRequestOf<Op>,
    timeoutMs: number,
  ): Promise<WorkerResults[Op]> {
    const running = await this.ensure();
    await running.ready;
    return this.send(running, request, timeoutMs) as Promise<WorkerResults[Op]>;
  }

  /** Stop the child; the next request starts it again. */
  stop(): void {
    const running = this.running;
    if (!running || running.stopping) {
      return;
    }
    running.stopping = true;
    this.clearIdle();
    try {
      running.child.disconnect();
    } catch {
      running.terminator.terminate();
      return;
    }
    setTimeout(() => running.terminator.terminate(), STOP_GRACE_MS).unref();
  }

  onApplicationShutdown(): void {
    this.closeAll();
  }

  /** End the child on the way out. Idempotent; the pidfile and lock hooks call it too. */
  closeAll(): void {
    this.shuttingDown = true;
    this.clearIdle();
    const running = this.running;
    if (!running) {
      return;
    }
    running.stopping = true;
    running.terminator.terminate();
  }

  private async ensure(): Promise<Running> {
    if (this.shuttingDown) {
      throw new EmbeddingUnavailableError('the daemon is shutting down');
    }
    if (this.running && !this.running.stopping) {
      return this.running;
    }
    if (Date.now() < this.downUntil) {
      throw new EmbeddingUnavailableError(
        `the embedding process is down: ${this.lastFailure ?? 'it crashed'}`,
      );
    }
    return this.start();
  }

  private start(): Running {
    const child = spawn(this.launch.command, this.launch.args, {
      detached: true,
      env: buildChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const terminator = createGroupTerminator(child, {
      isGone: () => child.exitCode !== null || child.signalCode !== null,
    });
    trackDetachedChild(child, this.launch.command);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) =>
      this.logger.debug(`embedding child: ${chunk.trimEnd()}`),
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) =>
      this.logger.warn(`embedding child: ${chunk.trimEnd()}`),
    );
    child.on('message', (message: unknown) => this.answer(message));
    child.on('error', (err) =>
      this.exited(child, `could not start: ${err.message}`),
    );
    child.on('exit', (code, signal) =>
      this.exited(child, `exited with ${signal ?? `code ${String(code)}`}`),
    );
    const running: Running = {
      child,
      terminator,
      stopping: false,
      ready: Promise.resolve(),
    };
    running.ready = (async () => {
      await this.send(
        running,
        { op: 'open', dbPath: this.launch.dbPath },
        30_000,
      );
      await this.send(
        running,
        {
          op: 'models',
          active: this.models.active,
          pending: this.models.pending,
        },
        30_000,
      );
    })();
    running.ready.catch(() => running.terminator.terminate());
    this.running = running;
    this.events.next({ kind: 'started' });
    return running;
  }

  private send(
    running: Running,
    request: WorkerRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    this.clearIdle();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.armIdle();
        reject(
          new EmbeddingUnavailableError(
            `${request.op} took longer than ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { op: request.op, resolve, reject, timer });
      try {
        running.child.send({ id, ...request });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new EmbeddingUnavailableError(
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    });
  }

  private answer(message: unknown): void {
    const reply = message as WorkerMessage;
    if (
      typeof reply !== 'object' ||
      reply === null ||
      typeof reply.id !== 'number'
    ) {
      return;
    }
    const waiting = this.pending.get(reply.id);
    if (!waiting) {
      return;
    }
    this.pending.delete(reply.id);
    clearTimeout(waiting.timer);
    this.armIdle();
    if (reply.ok) {
      if (WORK_OPS.has(waiting.op)) {
        this.failures = 0;
      }
      waiting.resolve(reply.result);
    } else {
      waiting.reject(new Error(reply.error));
    }
  }

  private exited(child: ChildProcess, how: string): void {
    const running = this.running;
    if (!running || running.child !== child) {
      return;
    }
    this.running = null;
    this.clearIdle();
    running.terminator.disarm();
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(
        new EmbeddingUnavailableError(`the embedding process ${how}`),
      );
      this.pending.delete(id);
    }
    if (running.stopping || this.shuttingDown) {
      this.events.next({ kind: 'stopped' });
      return;
    }
    this.failures += 1;
    this.lastFailure = `the embedding process ${how}`;
    const delay = EMBEDDING_RESTART_DELAYS_MS[this.failures - 1];
    const restartInMs = delay ?? EMBEDDING_GIVE_UP_MS;
    this.downUntil = Date.now() + restartInMs;
    this.logger.warn(
      `${this.lastFailure}; ${delay === undefined ? 'giving up for now' : `may restart in ${delay} ms`}`,
    );
    this.events.next({
      kind: 'crashed',
      reason: this.lastFailure,
      restartInMs,
    });
  }

  private armIdle(): void {
    if (this.pending.size > 0 || !this.running || this.running.stopping) {
      return;
    }
    this.clearIdle();
    this.idleTimer = setTimeout(
      () => this.stop(),
      this.launch.idleUnloadMs ?? EMBEDDING_IDLE_UNLOAD_MS,
    );
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
