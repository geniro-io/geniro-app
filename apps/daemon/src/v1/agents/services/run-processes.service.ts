import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import {
  type AppProcessesWire,
  type AppProcessThread,
  type KeptProcessRoot,
  MAX_PROCESS_ARGS_CHARS,
  type ProcessFigures,
  type RunProcess,
  type RunProcessesWire,
  type RunProcessTree,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import {
  listProcessUsage,
  type OwnedProcess,
  processName,
  processTreeOf,
  type ProcessUsageRow,
} from '../utils/process-usage';
import {
  callConversationOf,
  parseSessionKey,
  runIdOfSessionKey,
} from '../utils/session-keys';
import { AgentSessionRegistry } from './agent-session.registry';

const PS_UNREADABLE =
  'the process table could not be read — `ps` failed or timed out';

/** Kept to one decimal: `ps` reports no finer, and sums drift past it. */
function roundCpu(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * What one run has running right now — every kept agent CLI, everything under
 * it, and what each costs (`GET /v1/chats/:runId/processes`).
 *
 * Attribution is EXPLICIT: it starts from the pids this daemon spawned for the
 * run, which `AgentSessionRegistry` holds, and follows only what the OS records
 * about them (parent links and the process group — see `processTreeOf`). No
 * command line is matched, so a user's own `claude` in a terminal, or another
 * run's identical MCP server, can never be counted here.
 *
 * Kind-blind like the waterfall beside it: a workflow run's processes are
 * kept under `<runId>::…` keys and come back as one tree per node or call.
 */
@Injectable()
export class RunProcessesService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly listUsage: () => Promise<
      ProcessUsageRow[] | null
    > = listProcessUsage,
    private readonly selfPid: number = process.pid,
  ) {}

  /**
   * Every thread's share of the machine at once, plus geniro's own — the
   * title bar's usage readout (`GET /v1/chats/processes`).
   *
   * Threads are attributed exactly as {@link read} attributes one: from the
   * pids this daemon spawned. Geniro's own figure is what is left of the tree
   * that started the daemon — the window, its helpers, the daemon itself, the
   * terminal panel's shells — once every thread's processes are taken out, so
   * no process is counted twice. The `ps` read is paid even with no agent
   * running, because geniro's own figure is part of the answer.
   */
  async readAll(): Promise<AppProcessesWire> {
    const sampledAt = new Date().toISOString();
    const rows = await this.listUsage();
    if (rows === null) {
      return {
        sampledAt,
        threads: [],
        geniro: null,
        total: figuresOf([]),
        unavailableReason: PS_UNREADABLE,
      };
    }
    const claimed = new Set<number>();
    const byRun = new Map<
      string,
      { kinds: Set<AgentKind>; agents: number; owned: OwnedProcess[] }
    >();
    for (const root of this.sessions.processRoots()) {
      const owned = processTreeOf(rows, root.pid).filter(
        (row) => !claimed.has(row.pid),
      );
      if (owned.length === 0) {
        continue;
      }
      owned.forEach((row) => claimed.add(row.pid));
      const runId = runIdOfSessionKey(root.key);
      const thread = byRun.get(runId) ?? {
        kinds: new Set<AgentKind>(),
        agents: 0,
        owned: [],
      };
      const kind = AgentKindSchema.safeParse(root.agent);
      if (kind.success) {
        thread.kinds.add(kind.data);
      }
      thread.agents += 1;
      thread.owned.push(...owned);
      byRun.set(runId, thread);
    }

    const titles = new Map<string, string | null>();
    if (byRun.size > 0) {
      const runs = await this.runDao.getAll(
        { id: { $in: [...byRun.keys()] } },
        undefined,
        this.em.fork(),
      );
      for (const run of runs) {
        titles.set(run.id, run.title ?? null);
      }
    }
    const threads: AppProcessThread[] = [...byRun].map(([runId, thread]) => ({
      runId,
      title: titles.get(runId) ?? null,
      agentKinds: [...thread.kinds],
      agents: thread.agents,
      figures: figuresOf(thread.owned),
    }));
    threads.sort((a, b) => b.figures.rssBytes - a.figures.rssBytes);

    const geniro = figuresOf(
      processTreeOf(rows, this.appRootPid(rows)).filter(
        (row) => !claimed.has(row.pid),
      ),
    );
    return {
      sampledAt,
      threads,
      geniro,
      total: {
        processes:
          geniro.processes +
          threads.reduce((sum, t) => sum + t.figures.processes, 0),
        cpuPercent: roundCpu(
          geniro.cpuPercent +
            threads.reduce((sum, t) => sum + t.figures.cpuPercent, 0),
        ),
        rssBytes:
          geniro.rssBytes +
          threads.reduce((sum, t) => sum + t.figures.rssBytes, 0),
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
    // No kept process means nothing to attribute — and no reason to pay for a
    // whole-machine `ps` on every poll of an idle chat.
    if (roots.length === 0) {
      return emptyReading(sampledAt, null);
    }
    const rows = await this.listUsage();
    if (rows === null) {
      return emptyReading(sampledAt, PS_UNREADABLE);
    }
    const trees = roots
      .map((root) => treeFor(root, processTreeOf(rows, root.pid)))
      .filter((tree): tree is RunProcessTree => tree !== null);
    return {
      sampledAt,
      trees,
      processes: trees.reduce((sum, tree) => sum + tree.processes.length, 0),
      cpuPercent: roundCpu(
        trees.reduce((sum, tree) => sum + tree.cpuPercent, 0),
      ),
      rssBytes: trees.reduce((sum, tree) => sum + tree.rssBytes, 0),
      unavailableReason: null,
    };
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
