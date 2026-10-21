import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  MONITOR_RUN_MAX,
  type MonitorBatch,
  type MonitorEnd,
  type MonitorEvent,
  type MonitorOwner,
  type MonitorSnapshot,
  type MonitorStartOutcome,
  type MonitorStartRequest,
  type MonitorStopCause,
  type MonitorStopOutcome,
} from '../chat.types';
import {
  type ManagedStream,
  type ManagedStreamEnd,
  startManagedStream,
} from '../utils/managed-stream';
import {
  MONITOR_BATCH_WINDOW_MS,
  MonitorBatcher,
} from '../utils/monitor-batcher';
import { describeMonitorEnd } from '../utils/monitor-text';
import { runTagEnv } from '../utils/run-process-scan';
import { ProcessRegistry } from './process-registry';
import { currentRunOwner } from './run-process-attribution.service';

/** How long after a run's monitors were ended a new one still starts refused. */
const ABORTED_RUN_MS = 10_000;

/** How many ended monitors a run remembers, so `stop_monitor` can say how one ended. */
const ENDED_KEPT = 32;

interface RunningMonitor {
  id: string;
  owner: MonitorOwner;
  command: string;
  description: string;
  timeoutMs: number;
  startedAt: number;
  events: number;
  stream: ManagedStream;
  batcher: MonitorBatcher;
  window: NodeJS.Timeout | null;
  cause: MonitorStopCause | 'flooded' | null;
  ended: Promise<void>;
}

/**
 * The monitors every run has running — the `monitor` tool's commands, owned by
 * the daemon rather than found by process attribution (a tagged `/bin/sh`
 * root is invisible to `ps -E` on macOS, and the packaged daemon's own
 * runtime is fenced as a system executable).
 *
 * A leaf: ProcessRegistry is its only dependency. Delivery — rows, chat turns,
 * workflow wakes — subscribes to its events, so `RunTeardownService` and the
 * chat side can inject it without a cycle back to them.
 */
@Injectable()
export class MonitorRegistry implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MonitorRegistry.name);
  private readonly running = new Map<string, Map<string, RunningMonitor>>();
  private readonly counters = new Map<string, number>();
  private readonly abortedAt = new Map<string, number>();
  private readonly endedOf = new Map<
    string,
    Map<string, { caller: string; end: MonitorEnd }>
  >();
  private readonly listeners = new Set<
    (event: MonitorEvent) => void | Promise<void>
  >();
  private stopping = false;

  constructor(private readonly processes: ProcessRegistry) {}

  /**
   * Receive every monitor event; the returned function unsubscribes. A
   * listener's promise for an `end` is waited on by {@link settled}, so a
   * delete never removes a run's rows ahead of a monitor's last one.
   */
  subscribe(
    listener: (event: MonitorEvent) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(request: MonitorStartRequest): MonitorStartOutcome {
    const { runId } = request.owner;
    if (this.stopping) {
      return { status: 'refused', reason: 'geniro is shutting down' };
    }
    if (this.isEnding(runId)) {
      return { status: 'refused', reason: 'this thread is being closed' };
    }
    const monitors = this.running.get(runId) ?? new Map();
    if (monitors.size >= MONITOR_RUN_MAX) {
      return {
        status: 'refused',
        reason: `this thread already runs ${MONITOR_RUN_MAX} monitors, the most it may — stop one with stop_monitor first`,
      };
    }
    const count = (this.counters.get(runId) ?? 0) + 1;
    this.counters.set(runId, count);
    const id = `m${count}`;
    let resolveEnded: () => void = () => undefined;
    const monitor: RunningMonitor = {
      id,
      owner: request.owner,
      command: request.command,
      description: request.description,
      timeoutMs: request.timeoutMs,
      startedAt: Date.now(),
      events: 0,
      stream: {
        pid: null,
        stop: () => undefined,
        ended: new Promise(() => undefined),
      },
      batcher: new MonitorBatcher(),
      window: null,
      cause: null,
      ended: new Promise((resolve) => {
        resolveEnded = resolve;
      }),
    };
    monitors.set(id, monitor);
    this.running.set(runId, monitors);
    monitor.stream = startManagedStream({
      registryKey: `monitor:${runId}:${id}`,
      commandLine: request.command,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: runTagEnv(runId, currentRunOwner()),
      timeoutMs: request.timeoutMs,
      processes: this.processes,
      onData: (chunk) => this.receive(monitor, chunk),
    });
    void this.emit({ type: 'start', monitor: this.snapshot(monitor) });
    void monitor.stream.ended
      .then((end) => this.finish(monitor, end))
      .finally(resolveEnded);
    return { status: 'started', id };
  }

  /**
   * Stop one monitor. With `caller`, only that conversation's own: an agent
   * may stop no monitor but those it started.
   */
  stop(
    runId: string,
    id: string,
    cause: MonitorStopCause,
    caller?: string,
  ): MonitorStopOutcome {
    const monitor = this.running.get(runId)?.get(id);
    const ended = this.endedOf.get(runId)?.get(id);
    if (
      monitor === undefined &&
      ended !== undefined &&
      (caller === undefined || ended.caller === caller)
    ) {
      return {
        status: 'refused',
        reason: `already ended: ${describeMonitorEnd(ended.end)}`,
      };
    }
    if (
      monitor === undefined ||
      (caller !== undefined && monitor.owner.caller !== caller)
    ) {
      return {
        status: 'refused',
        reason: `no running monitor ${id} of yours`,
      };
    }
    if (monitor.cause !== null) {
      return { status: 'refused', reason: 'already ended: it is stopping' };
    }
    monitor.cause = cause;
    monitor.stream.stop();
    return { status: 'stopped' };
  }

  /** Stop every monitor the run has running. */
  stopRun(runId: string, cause: MonitorStopCause): void {
    for (const monitor of this.running.get(runId)?.values() ?? []) {
      if (monitor.cause === null) {
        monitor.cause = cause;
        monitor.stream.stop();
      }
    }
  }

  /** Stop every monitor of one conversation — a cancelled call's callee. */
  stopConversation(
    runId: string,
    caller: string,
    cause: MonitorStopCause,
  ): void {
    for (const monitor of this.running.get(runId)?.values() ?? []) {
      if (monitor.owner.caller === caller && monitor.cause === null) {
        monitor.cause = cause;
        monitor.stream.stop();
      }
    }
  }

  /**
   * Ids the run's transcript already holds (a previous launch's), so a new
   * monitor is never minted under one of them: the counter is per launch.
   */
  noteUsedIds(runId: string, ids: Iterable<string>): void {
    let highest = this.counters.get(runId) ?? 0;
    for (const id of ids) {
      const n = Number(/^m(\d+)$/.exec(id)?.[1] ?? 0);
      highest = Math.max(highest, n);
    }
    this.counters.set(runId, highest);
  }

  /** Archive or delete: stop the run's monitors and refuse new ones for a moment. */
  abortRun(runId: string): void {
    const now = Date.now();
    for (const [id, at] of this.abortedAt) {
      if (now - at >= ABORTED_RUN_MS) {
        this.abortedAt.delete(id);
      }
    }
    this.abortedAt.set(runId, now);
    this.stopRun(runId, 'teardown');
  }

  /** The run is back (unarchived): monitors start normally again. */
  allowRun(runId: string): void {
    this.abortedAt.delete(runId);
  }

  /** Whether a monitor started in the run now would be refused as closing. */
  isEnding(runId: string): boolean {
    const aborted = this.abortedAt.get(runId);
    return aborted !== undefined && Date.now() - aborted < ABORTED_RUN_MS;
  }

  /** Whether the run has a monitor running that nothing has stopped. */
  isRunning(runId: string): boolean {
    return [...(this.running.get(runId)?.values() ?? [])].some(
      (monitor) => monitor.cause === null,
    );
  }

  /** Whether one conversation has a monitor running that nothing has stopped. */
  isRunningFor(runId: string, caller: string): boolean {
    return [...(this.running.get(runId)?.values() ?? [])].some(
      (monitor) => monitor.owner.caller === caller && monitor.cause === null,
    );
  }

  /** Every run's monitors still running. */
  listAll(): MonitorSnapshot[] {
    return [...this.running.values()].flatMap((monitors) =>
      [...monitors.values()].map((monitor) => this.snapshot(monitor)),
    );
  }

  /** The run's monitors still running — every conversation's, or one caller's. */
  list(runId: string, caller?: string): MonitorSnapshot[] {
    return [...(this.running.get(runId)?.values() ?? [])]
      .filter(
        (monitor) => caller === undefined || monitor.owner.caller === caller,
      )
      .map((monitor) => this.snapshot(monitor));
  }

  /**
   * Resolves once every monitor the run has running has emitted its end, or
   * `timeoutMs` has passed — a delete waits here so no row lands after the
   * run's rows are gone.
   */
  async settled(runId: string, timeoutMs: number): Promise<void> {
    const pending = [...(this.running.get(runId)?.values() ?? [])].map(
      (monitor) => monitor.ended,
    );
    if (pending.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Ahead of ProcessRegistry's drain. No end is emitted: the monitors are left
   * without an end row, which is what the next boot's sweep reads as
   * interrupted by the restart.
   */
  beforeApplicationShutdown(): void {
    this.stopping = true;
    for (const monitors of this.running.values()) {
      for (const monitor of monitors.values()) {
        monitor.stream.stop();
      }
    }
  }

  private receive(monitor: RunningMonitor, chunk: string): void {
    if (monitor.cause !== null) {
      return;
    }
    if (monitor.batcher.push(chunk) === 'flooded') {
      monitor.cause = 'flooded';
      monitor.stream.stop();
      return;
    }
    if (monitor.window === null) {
      monitor.window = setTimeout(() => {
        monitor.window = null;
        // A stopping monitor's lines are its end's to carry (`finish`).
        if (monitor.cause !== null) {
          return;
        }
        const batch = monitor.batcher.take();
        if (batch !== null) {
          monitor.events += 1;
          void this.emit({
            type: 'batch',
            monitor: this.snapshot(monitor),
            batch,
          });
        }
      }, MONITOR_BATCH_WINDOW_MS);
      monitor.window.unref();
    }
  }

  private async finish(
    monitor: RunningMonitor,
    outcome: ManagedStreamEnd,
  ): Promise<void> {
    if (monitor.window !== null) {
      clearTimeout(monitor.window);
      monitor.window = null;
    }
    const monitors = this.running.get(monitor.owner.runId);
    monitors?.delete(monitor.id);
    if (monitors?.size === 0) {
      this.running.delete(monitor.owner.runId);
    }
    if (this.stopping) {
      return;
    }
    const cause = monitor.cause;
    let batch = monitor.batcher.take(true);
    if (outcome.spawnError !== undefined) {
      batch = {
        lines: [
          ...(batch?.lines ?? []),
          `could not start: ${outcome.spawnError}`,
        ],
        omitted: batch?.omitted ?? 0,
      };
    }
    const end: MonitorEnd =
      cause === 'flooded'
        ? { kind: 'flooded' }
        : cause !== null
          ? { kind: 'stopped' }
          : outcome.timedOut
            ? { kind: 'timeout' }
            : outcome.code !== null
              ? { kind: 'exit', code: outcome.code }
              : outcome.signal !== null
                ? { kind: 'signal', signal: outcome.signal }
                : { kind: 'exit', code: 127 };
    const ended =
      this.endedOf.get(monitor.owner.runId) ??
      new Map<string, { caller: string; end: MonitorEnd }>();
    ended.set(monitor.id, { caller: monitor.owner.caller, end });
    for (const old of ended.keys()) {
      if (ended.size <= ENDED_KEPT) {
        break;
      }
      ended.delete(old);
    }
    this.endedOf.set(monitor.owner.runId, ended);
    if (batch !== null) {
      monitor.events += 1;
    }
    await this.emit({
      type: 'end',
      monitor: this.snapshot(monitor),
      end,
      batch,
      wake: cause === null || cause === 'flooded' || cause === 'user',
      stoppedBy: cause === 'flooded' ? null : cause,
    });
  }

  private snapshot(monitor: RunningMonitor): MonitorSnapshot {
    return {
      id: monitor.id,
      owner: monitor.owner,
      description: monitor.description,
      command: monitor.command,
      startedAt: new Date(monitor.startedAt).toISOString(),
      endsAt: new Date(monitor.startedAt + monitor.timeoutMs).toISOString(),
      timeoutMs: monitor.timeoutMs,
      events: monitor.events,
      pid: monitor.stream.pid,
    };
  }

  private async emit(event: MonitorEvent): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          pending.push(
            result.catch((err: unknown) => this.listenerFailed(event, err)),
          );
        }
      } catch (err) {
        this.listenerFailed(event, err);
      }
    }
    await Promise.all(pending);
  }

  private listenerFailed(event: MonitorEvent, err: unknown): void {
    this.logger.error(
      `monitor ${event.monitor.id} of run ${event.monitor.owner.runId}: a listener failed on ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
