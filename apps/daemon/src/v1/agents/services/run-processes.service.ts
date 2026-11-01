import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import type { MonitorSnapshot } from '../chat.types';
import {
  type AppProcessesWire,
  type AppProcessThread,
  type KeptProcessRoot,
  MAX_PROCESS_ARGS_CHARS,
  type ProcessFigures,
  type RunMonitor,
  type RunProcess,
  type RunProcessesWire,
  type RunProcessTree,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import {
  listProcessUsage,
  type OwnedProcess,
  processName,
  processSetTree,
  processTreeOf,
  type ProcessUsageRow,
} from '../utils/process-usage';
import {
  callConversationOf,
  parseSessionKey,
  runIdOfSessionKey,
} from '../utils/session-keys';
import { AgentSessionRegistry } from './agent-session.registry';
import { MonitorRegistry } from './monitor.registry';
import { RunProcessAttribution } from './run-process-attribution.service';
import { RunProcessReaper } from './run-process-reaper.service';

const PS_UNREADABLE =
  'the process table could not be read — `ps` failed or timed out';

/** Kept to one decimal: `ps` reports no finer, and sums drift past it. */
function roundCpu(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Test seams — the production factory passes none. */
export interface RunProcessesOptions {
  listUsage?: () => Promise<ProcessUsageRow[] | null>;
  selfPid?: number;
}

/**
 * What one run has running right now — every kept agent CLI, everything under
 * it, everything its agents left running detached, and what each costs
 * (`GET /v1/chats/:runId/processes`).
 *
 * Attribution is EXPLICIT, never a command-line match, so a user's own
 * `claude` in a terminal, or another run's identical MCP server, can never be
 * counted here. Two sources, in order: the pids this daemon spawned for the run
 * (`AgentSessionRegistry`) and what the OS records about them (parent links and
 * the process group — see `processTreeOf`); then the run's tag in the
 * environment (`RunProcessAttribution`), which reaches what was detached and
 * adopted by launchd. That is the very attribution the run's teardown stops by,
 * so what this shows under a thread is what archiving it ends.
 *
 * Kind-blind like the waterfall beside it: a team run's processes are
 * kept under `<runId>::…` keys and come back as one tree per node or call.
 *
 * A `monitor` command is the daemon's own child, found by its registry rather
 * than its tag (a tagged `/bin/sh` is invisible to `ps -E`), and claimed with
 * its whole process group, so it is one row and never also listed as detached.
 */
@Injectable()
export class RunProcessesService {
  private readonly listUsage: () => Promise<ProcessUsageRow[] | null>;
  private readonly selfPid: number;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly attribution: RunProcessAttribution,
    private readonly reaper: RunProcessReaper,
    private readonly monitors: MonitorRegistry,
    options: RunProcessesOptions = {},
  ) {
    this.listUsage = options.listUsage ?? listProcessUsage;
    this.selfPid = options.selfPid ?? process.pid;
  }

  /**
   * The pids each run owns by its tag.
   * Empty when the table could not be read with environments: the CLI trees
   * still stand, and nothing is guessed.
   */
  private async tagged(): Promise<Map<string, Set<number>>> {
    const reading = await this.attribution.attribute('readout');
    if (reading === null) {
      return new Map();
    }
    return new Map(
      [...reading].map(([runId, procs]) => [
        runId,
        new Set(procs.map((proc) => proc.pid)),
      ]),
    );
  }

  /**
   * Every thread's share of the machine at once, plus geniro's own — the
   * title bar's usage readout (`GET /v1/chats/processes`).
   *
   * Threads are attributed exactly as {@link read} attributes one. What a
   * thread that is gone or archived still has running is `leftover` — the
   * sweep's to stop, shown until it has. Geniro's own figure is what is left
   * of the tree that started the daemon — the window, its helpers, the
   * daemon itself, the terminal panel's shells — once every thread's processes
   * are taken out, so no process is counted twice. The `ps` read is paid even
   * with no agent running, because geniro's own figure is part of the answer.
   */
  async readAll(): Promise<AppProcessesWire> {
    const sampledAt = new Date().toISOString();
    const [rows, tagged] = await Promise.all([this.listUsage(), this.tagged()]);
    if (rows === null) {
      return {
        sampledAt,
        threads: [],
        geniro: null,
        leftover: null,
        total: figuresOf([]),
        unavailableReason: PS_UNREADABLE,
      };
    }
    const claimed = new Set<number>();
    const byRun = new Map<
      string,
      {
        kinds: Set<AgentKind>;
        agents: number;
        owned: ProcessUsageRow[];
        detached: number;
      }
    >();
    const threadOf = (runId: string) => {
      const thread = byRun.get(runId) ?? {
        kinds: new Set<AgentKind>(),
        agents: 0,
        owned: [],
        detached: 0,
      };
      byRun.set(runId, thread);
      return thread;
    };
    for (const root of this.sessions.processRoots()) {
      const owned = processTreeOf(rows, root.pid).filter(
        (row) => !claimed.has(row.pid),
      );
      if (owned.length === 0) {
        continue;
      }
      owned.forEach((row) => claimed.add(row.pid));
      const thread = threadOf(runIdOfSessionKey(root.key));
      const kind = AgentKindSchema.safeParse(root.agent);
      if (kind.success) {
        thread.kinds.add(kind.data);
      }
      thread.agents += 1;
      thread.owned.push(...owned);
    }

    for (const monitor of this.monitors.listAll()) {
      const owned = monitorProcesses(rows, monitor).filter(
        (row) => !claimed.has(row.pid),
      );
      owned.forEach((row) => claimed.add(row.pid));
      const thread = threadOf(monitor.owner.runId);
      thread.owned.push(...owned);
      thread.detached += owned.length;
    }

    const runs = new Map<string, { title: string | null; live: boolean }>();
    // Held is the registry's word, as it is the sweep's: a run with a live
    // agent is never leftover, whatever its row says.
    const held = new Set(
      this.sessions.processRoots().map((root) => runIdOfSessionKey(root.key)),
    );
    const runIds = new Set([...byRun.keys(), ...tagged.keys()]);
    if (runIds.size > 0) {
      for (const run of await this.runDao.getAll(
        { id: { $in: [...runIds] } },
        undefined,
        this.em.fork(),
      )) {
        runs.set(run.id, {
          title: run.title ?? null,
          live: run.archivedAt === null,
        });
      }
    }
    const leftover: ProcessUsageRow[] = [];
    for (const [runId, pids] of tagged) {
      const detached = rows.filter(
        (row) => pids.has(row.pid) && !claimed.has(row.pid),
      );
      if (detached.length === 0) {
        continue;
      }
      detached.forEach((row) => claimed.add(row.pid));
      if (runs.get(runId)?.live === true || held.has(runId)) {
        const thread = threadOf(runId);
        thread.owned.push(...detached);
        thread.detached += detached.length;
      } else {
        leftover.push(...detached);
      }
    }

    const threads: AppProcessThread[] = [...byRun].map(([runId, thread]) => ({
      runId,
      title: runs.get(runId)?.title ?? null,
      agentKinds: [...thread.kinds],
      agents: thread.agents,
      detachedProcesses: thread.detached,
      figures: figuresOf(thread.owned),
    }));
    threads.sort((a, b) => b.figures.rssBytes - a.figures.rssBytes);

    const geniro = figuresOf(
      processTreeOf(rows, this.appRootPid(rows)).filter(
        (row) => !claimed.has(row.pid),
      ),
    );
    const left = figuresOf(leftover);
    const parts = [geniro, left, ...threads.map((t) => t.figures)];
    return {
      sampledAt,
      threads,
      geniro,
      leftover: left,
      total: {
        processes: parts.reduce((sum, p) => sum + p.processes, 0),
        cpuPercent: roundCpu(parts.reduce((sum, p) => sum + p.cpuPercent, 0)),
        rssBytes: parts.reduce((sum, p) => sum + p.rssBytes, 0),
      },
      unavailableReason: null,
    };
  }

  /**
   * The process that started this daemon — the Electron main process, whose
   * tree is the app — or the daemon itself when it was started by launchd or
   * by nothing the table still lists.
   */
  private appRootPid(rows: readonly ProcessUsageRow[]): number {
    const self = rows.find((row) => row.pid === this.selfPid);
    if (self !== undefined && self.ppid > 1) {
      return self.ppid;
    }
    return this.selfPid;
  }

  async read(runId: string): Promise<RunProcessesWire> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    const sampledAt = new Date().toISOString();
    const roots = this.sessions.processRoots(runId);
    // Read even with no kept CLI: what its agents detached outlives them.
    const [rows, tagged] = await Promise.all([this.listUsage(), this.tagged()]);
    if (rows === null) {
      return emptyReading(sampledAt, PS_UNREADABLE);
    }
    const trees = roots
      .map((root) => treeFor(root, processTreeOf(rows, root.pid)))
      .filter((tree): tree is RunProcessTree => tree !== null);
    const monitors = this.monitors
      .list(runId)
      .map((monitor) => monitorFor(monitor, monitorProcesses(rows, monitor)));
    const inTrees = new Set([
      ...trees.flatMap((tree) => tree.processes.map((proc) => proc.pid)),
      ...monitors.flatMap((monitor) =>
        monitor.processes.map((proc) => proc.pid),
      ),
    ]);
    const detachedPids = new Set(
      [...(tagged.get(runId) ?? [])].filter((pid) => !inTrees.has(pid)),
    );
    const detached = processSetTree(rows, detachedPids).map(toWire);
    const all = [
      ...trees.flatMap((tree) => tree.processes),
      ...detached,
      ...monitors.flatMap((monitor) => monitor.processes),
    ];
    return {
      sampledAt,
      trees,
      detached,
      monitors,
      processes: all.length,
      cpuPercent: roundCpu(all.reduce((sum, proc) => sum + proc.cpuPercent, 0)),
      rssBytes: all.reduce((sum, proc) => sum + proc.rssBytes, 0),
      unavailableReason: null,
    };
  }

  /**
   * Stop what the user picked in the panel: detached processes through the
   * reaper's checks, monitors through their registry — a monitor stopped here
   * ends `stopped` and wakes its agent to say so.
   */
  async stopDetached(
    runId: string,
    selection: { pids?: readonly number[]; monitorIds?: readonly string[] },
  ): Promise<{ stoppedPids: number[]; stoppedMonitorIds: string[] }> {
    if ((await this.runDao.getById(runId, this.em.fork())) === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    // The pids first: the reaper refuses a selection whole, and a refused
    // request must not have stopped the monitors beside it.
    const pids = selection.pids ?? [];
    const stoppedPids =
      pids.length === 0 ? [] : await this.reaper.stopDetached(runId, pids);
    const stoppedMonitorIds = (selection.monitorIds ?? []).filter(
      (id) => this.monitors.stop(runId, id, 'user').status === 'stopped',
    );
    return { stoppedPids, stoppedMonitorIds };
  }
}

function figuresOf(rows: readonly ProcessUsageRow[]): ProcessFigures {
  return {
    processes: rows.length,
    cpuPercent: roundCpu(rows.reduce((sum, row) => sum + row.cpuPercent, 0)),
    rssBytes: rows.reduce((sum, row) => sum + row.rssBytes, 0),
  };
}

function emptyReading(
  sampledAt: string,
  unavailableReason: string | null,
): RunProcessesWire {
  return {
    sampledAt,
    trees: [],
    detached: [],
    monitors: [],
    processes: 0,
    cpuPercent: 0,
    rssBytes: 0,
    unavailableReason,
  };
}

/** Null when the CLI ended between the registry read and the `ps` read. */
function treeFor(
  root: KeptProcessRoot,
  owned: readonly OwnedProcess[],
): RunProcessTree | null {
  if (owned.length === 0) {
    return null;
  }
  const processes = owned.map(toWire);
  const kind = AgentKindSchema.safeParse(root.agent);
  return {
    sessionKey: root.key,
    nodeId: parseSessionKey(root.key)?.nodeId ?? null,
    conversationId: callConversationOf(root.key),
    agentKind: kind.success ? kind.data : null,
    cwd: root.cwd,
    rootPid: root.pid,
    processes,
    cpuPercent: roundCpu(processes.reduce((sum, p) => sum + p.cpuPercent, 0)),
    rssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
  };
}

/** A monitor's shell and everything in its process group, or nothing once it has ended. */
function monitorProcesses(
  rows: readonly ProcessUsageRow[],
  monitor: MonitorSnapshot,
): OwnedProcess[] {
  return monitor.pid === null ? [] : processTreeOf(rows, monitor.pid);
}

function monitorFor(
  monitor: MonitorSnapshot,
  owned: readonly OwnedProcess[],
): RunMonitor {
  const processes = owned.map(toWire);
  return {
    id: monitor.id,
    description: monitor.description,
    command: redactSecrets(monitor.command).slice(0, MAX_PROCESS_ARGS_CHARS),
    startedAt: monitor.startedAt,
    endsAt: monitor.endsAt,
    pid: monitor.pid,
    processes,
    cpuPercent: roundCpu(processes.reduce((sum, p) => sum + p.cpuPercent, 0)),
    rssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
  };
}

function toWire(row: OwnedProcess): RunProcess {
  return {
    pid: row.pid,
    ppid: row.ppid,
    depth: row.depth,
    link: row.link,
    name: processName(row),
    // Redacted before it leaves the daemon: argv is where an MCP server's
    // launch line can carry a credential this daemon registered.
    args: redactSecrets(row.args).slice(0, MAX_PROCESS_ARGS_CHARS),
    cpuPercent: roundCpu(row.cpuPercent),
    rssBytes: row.rssBytes,
    elapsedSeconds: row.elapsedSeconds,
  };
}
