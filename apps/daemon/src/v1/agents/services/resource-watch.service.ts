import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import {
  DEFAULT_RESOURCE_ALERT_CONFIG,
  type ResourceAlert,
  type ResourceAlertConfig,
  type ResourceAlertKind,
  type ResourceAlertsWire,
  type StoppedResourceAlertCommand,
  type ThreadResourceSample,
} from '../chat.types';
import {
  firingConditions,
  growthPerMinute,
  parseConditionKey,
  type RssSample,
  SYSTEM_SCOPE,
  type ThreadReading,
} from '../utils/resource-alert-rules';
import {
  readFreeDiskBytes,
  readMemoryPressureLevel,
} from '../utils/system-resources';
import { AgentSessionRegistry } from './agent-session.registry';
import { MonitorRegistry } from './monitor.registry';
import { ResourceAlertEventBus } from './resource-alert-events.bus';
import { RunProcessReaper } from './run-process-reaper.service';
import { RunProcessesService } from './run-processes.service';

export const RESOURCE_WATCH_EVERY_MS = 30_000;

const HISTORY_KEEP_MS = 5 * 60_000;

export interface ResourceWatchOptions {
  readPressureLevel?: () => Promise<number | null>;
  readFreeDiskBytes?: () => Promise<number | null>;
  now?: () => number;
  logger?: { log(msg: string): void; warn(msg: string): void };
}

interface StopTarget {
  runId: string;
  pid: number;
  startedAt: number;
}

/**
 * Watches what threads' processes cost and what the machine has left, and
 * keeps the list of {@link ResourceAlert}s that hold right now.
 *
 * It reads anything only while some thread has processes — a kept agent CLI,
 * a monitor, or what the last reading found under a live thread — so an idle
 * app runs no `ps`, `sysctl` or `statfs`. Each reading is one
 * {@link RunProcessesService.sampleThreads}. It never stops anything itself:
 * {@link stop} is the user's press, through the reaper's identity checks, and
 * only for a command that was a stop candidate when its alert was raised.
 */
@Injectable()
export class ResourceWatchService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger: NonNullable<ResourceWatchOptions['logger']>;
  private readonly readPressureLevel: () => Promise<number | null>;
  private readonly readFreeDiskBytes: () => Promise<number | null>;
  private readonly now: () => number;
  private config: ResourceAlertConfig = DEFAULT_RESOURCE_ALERT_CONFIG;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly history = new Map<string, RssSample[]>();
  private readonly alerts = new Map<string, ResourceAlert>();
  private readonly targets = new Map<string, StopTarget>();
  private readonly unreadable = new Set<string>();
  private hadThreads = false;
  private seq = 0;
  private readonly bootId = randomUUID().slice(0, 8);

  constructor(
    private readonly processes: RunProcessesService,
    private readonly sessions: AgentSessionRegistry,
    private readonly monitors: MonitorRegistry,
    private readonly reaper: RunProcessReaper,
    private readonly bus: ResourceAlertEventBus,
    options: ResourceWatchOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(ResourceWatchService.name);
    this.readPressureLevel =
      options.readPressureLevel ?? readMemoryPressureLevel;
    this.readFreeDiskBytes = options.readFreeDiskBytes ?? readFreeDiskBytes;
    this.now = options.now ?? Date.now;
  }

  onApplicationBootstrap(): void {
    const every = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger.warn(
          `resource watch reading failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RESOURCE_WATCH_EVERY_MS);
    every.unref();
    this.timer = every;
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setConfig(config: ResourceAlertConfig): ResourceAlertConfig {
    this.config = config;
    if (!config.enabled) {
      this.history.clear();
      this.hadThreads = false;
      this.dropWhere(() => true);
    }
    return this.config;
  }

  list(): ResourceAlertsWire {
    return { alerts: [...this.alerts.values()] };
  }

  async stop(alertId: string): Promise<StoppedResourceAlertCommand> {
    const entry = [...this.alerts].find(([, alert]) => alert.id === alertId);
    if (entry === undefined) {
      throw new NotFoundException(
        'RESOURCE_ALERT_NOT_FOUND',
        `no resource alert: ${alertId}`,
      );
    }
    const target = this.targets.get(alertId);
    if (target === undefined) {
      throw new BadRequestException(
        'RESOURCE_ALERT_NOT_STOPPABLE',
        'this command is not one geniro may stop for its thread; open the thread’s processes instead',
      );
    }
    const { stopped } = await this.reaper.stopRecorded(target.runId, [
      { pid: target.pid, startedAt: target.startedAt },
    ]);
    const [key] = entry;
    if (this.alerts.get(key)?.id === alertId) {
      this.drop(key);
      this.bus.publish();
    }
    return { stoppedPids: stopped };
  }

  /** One reading; a reading still under way is joined, not doubled. */
  tick(): Promise<void> {
    this.running ??= this.tickOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private hasWork(): boolean {
    return (
      this.hadThreads ||
      this.sessions.processRoots().length > 0 ||
      this.monitors.listAll().length > 0
    );
  }

  private async tickOnce(): Promise<void> {
    if (!this.config.enabled) {
      this.dropWhere(() => true);
      return;
    }
    if (!this.hasWork()) {
      this.history.clear();
      this.dropWhere((key) => parseConditionKey(key).scope !== SYSTEM_SCOPE);
      return;
    }
    const [samples, pressureLevel, freeDiskBytes] = await Promise.all([
      this.processes.sampleThreads(),
      this.readPressureLevel(),
      this.readFreeDiskBytes(),
    ]);
    this.noteUnreadable('the process table', samples === null);
    this.noteUnreadable('the memory pressure level', pressureLevel === null);
    this.noteUnreadable('the free disk space', freeDiskBytes === null);
    const now = this.now();
    if (samples !== null) {
      this.hadThreads = samples.length > 0;
    }
    const readings = samples === null ? [] : this.record(samples, now);
    const previous = new Set(this.alerts.keys());
    const firing = firingConditions(this.config, previous, {
      threads: readings,
      pressureLevel,
      freeDiskBytes,
    });
    if (samples === null) {
      for (const key of previous) {
        if (parseConditionKey(key).scope !== SYSTEM_SCOPE) {
          firing.add(key);
        }
      }
    }
    const byRun = new Map((samples ?? []).map((s) => [s.runId, s]));
    const growthOf = new Map(
      readings.map((r) => [r.runId, r.growthBytesPerMinute]),
    );
    const heaviest = (samples ?? []).reduce<ThreadResourceSample | null>(
      (top, s) => (top === null || s.rssBytes > top.rssBytes ? s : top),
      null,
    );
    let changed = false;
    for (const key of previous) {
      if (!firing.has(key)) {
        this.drop(key);
        changed = true;
      }
    }
    for (const key of firing) {
      const { kind, scope } = parseConditionKey(key);
      const sample =
        scope === SYSTEM_SCOPE ? heaviest : (byRun.get(scope) ?? null);
      const growth =
        sample === null ? null : (growthOf.get(sample.runId) ?? null);
      const existing = this.alerts.get(key);
      if (existing !== undefined) {
        this.alerts.set(
          key,
          refreshed(
            existing,
            scope === SYSTEM_SCOPE ? null : sample,
            growth,
            freeDiskBytes,
          ),
        );
        continue;
      }
      this.alerts.set(
        key,
        await this.raise(
          kind,
          sample,
          {
            threadRssBytes: sample?.rssBytes ?? null,
            growthBytesPerMinute: growth,
            freeDiskBytes,
          },
          now,
        ),
      );
      changed = true;
    }
    if (changed) {
      this.bus.publish();
    }
  }

  private record(
    samples: readonly ThreadResourceSample[],
    now: number,
  ): ThreadReading[] {
    const live = new Set(samples.map((s) => s.runId));
    for (const runId of [...this.history.keys()]) {
      if (!live.has(runId)) {
        this.history.delete(runId);
      }
    }
    return samples.map((sample) => {
      const current = { at: now, rssBytes: sample.rssBytes };
      const kept = (this.history.get(sample.runId) ?? []).filter(
        (s) => now - s.at <= HISTORY_KEEP_MS,
      );
      const growth = growthPerMinute(kept, current);
      this.history.set(sample.runId, [...kept, current]);
      return {
        runId: sample.runId,
        rssBytes: sample.rssBytes,
        growthBytesPerMinute: growth,
      };
    });
  }

  private async raise(
    kind: ResourceAlertKind,
    sample: ThreadResourceSample | null,
    figures: Pick<
      ResourceAlert,
      'threadRssBytes' | 'growthBytesPerMinute' | 'freeDiskBytes'
    >,
    now: number,
  ): Promise<ResourceAlert> {
    this.seq += 1;
    const id = `ra-${this.bootId}-${this.seq}`;
    const heaviest = sample?.heaviest ?? null;
    const target =
      sample === null || heaviest === null || kind === 'low-disk'
        ? null
        : await this.stopTargetFor(sample.runId, heaviest.pid);
    if (target !== null) {
      this.targets.set(id, target);
    }
    return {
      id,
      kind,
      raisedAt: new Date(now).toISOString(),
      runId: sample?.runId ?? null,
      title: sample?.title ?? null,
      agentKind: heaviest?.agentKind ?? sample?.agentKinds[0] ?? null,
      memberId: heaviest?.memberId ?? null,
      command:
        heaviest === null
          ? null
          : {
              pid: heaviest.pid,
              name: heaviest.name,
              label: heaviest.label,
              rssBytes: heaviest.rssBytes,
            },
      ...figures,
      stoppable: target !== null,
    };
  }

  private async stopTargetFor(
    runId: string,
    pid: number,
  ): Promise<StopTarget | null> {
    try {
      const candidate = (await this.reaper.stopCandidates(runId)).find(
        (row) => row.pid === pid,
      );
      return candidate === undefined
        ? null
        : { runId, pid, startedAt: candidate.startedAt };
    } catch (err: unknown) {
      this.logger.warn(
        `could not tell whether pid ${pid} of run ${runId} may be stopped; its alert offers no Stop: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private drop(key: string): void {
    const alert = this.alerts.get(key);
    if (alert !== undefined) {
      this.targets.delete(alert.id);
    }
    this.alerts.delete(key);
  }

  private dropWhere(matches: (key: string) => boolean): void {
    const keys = [...this.alerts.keys()].filter(matches);
    if (keys.length === 0) {
      return;
    }
    keys.forEach((key) => this.drop(key));
    this.bus.publish();
  }

  private noteUnreadable(what: string, unreadable: boolean): void {
    if (!unreadable) {
      this.unreadable.delete(what);
      return;
    }
    if (!this.unreadable.has(what)) {
      this.unreadable.add(what);
      this.logger.warn(`resource watch could not read ${what}; skipped it`);
    }
  }
}

/**
 * A held alert's figures from this reading. A thread alert follows its thread;
 * a system alert keeps the thread it blamed when raised, and only its disk
 * figure moves. A figure that could not be read keeps its last value.
 */
function refreshed(
  alert: ResourceAlert,
  sample: ThreadResourceSample | null,
  growth: number | null,
  freeDiskBytes: number | null,
): ResourceAlert {
  const heaviest = sample?.heaviest ?? null;
  return {
    ...alert,
    threadRssBytes: sample?.rssBytes ?? alert.threadRssBytes,
    growthBytesPerMinute: sample === null ? alert.growthBytesPerMinute : growth,
    freeDiskBytes: freeDiskBytes ?? alert.freeDiskBytes,
    command:
      alert.command !== null && heaviest?.pid === alert.command.pid
        ? { ...alert.command, rssBytes: heaviest.rssBytes }
        : alert.command,
  };
}
