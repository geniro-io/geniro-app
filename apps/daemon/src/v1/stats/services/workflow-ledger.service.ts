import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { RunFacts } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { parseWorkflowSnapshot } from '../../graphs/utils/workflow-snapshot';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowVersionOf,
} from '../../graphs/utils/workflow-version';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { WorkflowVersionDao } from '../dao/workflow-version.dao';
import type { FailedNodeStamp } from '../stats.types';

/**
 * Runs created before this instant got no graph copy when they started; theirs was
 * frozen from the library on a later read, so their version is marked inferred. It is
 * the release that started keeping copies (v1.93.0, 2026-09-13), so on an install
 * updated later a run made in between is not marked, though its copy is as late.
 */
export const SNAPSHOT_AT_CREATION_SINCE = new Date('2026-09-14T00:00:00.000Z');

/** Runs the boot sweep stamps between yields to the event loop. */
const SWEEP_WINDOW = 25;

/**
 * The workflow ledger: stamps each workflow run's `usage_activity` thread row with its
 * graph version when it is created and with its outcome each time it settles, and records
 * each version's graph in `workflow_versions`. Both survive the run's deletion, which is
 * what lets the Workflows screen show a version's outcomes after its chats are gone.
 *
 * It observes the bus like `UsageActivityRecorderService`. Work for one run is queued so
 * its stamps land in the order the bus announced them; different runs do not wait on
 * each other.
 */
@Injectable()
export class WorkflowLedgerService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowLedgerService.name);
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly wallTurns: WallTurnDao,
    private readonly activityDao: UsageActivityDao,
    private readonly versionDao: WorkflowVersionDao,
  ) {}

  onModuleInit(): void {
    this.bus.allRunCreated().subscribe((event) => {
      void this.enqueue(event.runId, 'version', (em) =>
        this.recordVersion(event.runId, em),
      );
    });
    this.bus.allStatuses().subscribe((event) => {
      if (event.status !== null && isTerminalRunStatus(event.status)) {
        void this.enqueue(event.runId, 'outcome', (em) =>
          this.recordOutcome(event.runId, em),
        );
      }
    });
  }

  /** Resolves once every stamp queued so far has been written (or logged as failed). */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /**
   * Stamp every workflow run the ledger does not describe as it stands: no version stamp
   * yet (a run from before the ledger, or one whose announce was missed), or a settled
   * status that differs from the stamped one (a status written whose announce never went
   * out). Awaited at boot BEFORE the server listens, so nothing can delete a run before it
   * is stamped; a second call finds nothing to do.
   */
  async sweep(): Promise<{ versions: number; outcomes: number }> {
    const em = this.em.fork();
    const runs = await this.runDao.runFacts('every-workflow-run', em);
    const rows = await this.activityDao.threadRowsByRuns(
      runs.map((run) => run.id),
      em,
    );
    const unversioned = runs.filter((run) => {
      const row = rows.get(run.id);
      return row === undefined || row.slug === null;
    });
    const unsettled = runs.filter(
      (run) =>
        isTerminalRunStatus(run.status) &&
        rows.get(run.id)?.runStatus !== run.status,
    );
    let versions = 0;
    let outcomes = 0;
    for (let at = 0; at < unversioned.length; at += SWEEP_WINDOW) {
      const window = unversioned.slice(at, at + SWEEP_WINDOW);
      const snapshots = await this.runDao.workflowSnapshots(
        window.map((run) => run.id),
        em,
      );
      for (const run of window) {
        if (
          await this.guarded(run.id, 'version', () =>
            this.stampVersion(run, snapshots.get(run.id) ?? null, em),
          )
        ) {
          versions += 1;
        }
      }
      await yieldToEventLoop();
    }
    for (let at = 0; at < unsettled.length; at += SWEEP_WINDOW) {
      for (const run of unsettled.slice(at, at + SWEEP_WINDOW)) {
        if (
          await this.guarded(run.id, 'outcome', () =>
            this.stampOutcome(run, em),
          )
        ) {
          outcomes += 1;
        }
      }
      await yieldToEventLoop();
    }
    if (versions + outcomes > 0) {
      this.logger.log(
        `workflow ledger: stamped ${versions} version(s) and ${outcomes} outcome(s)`,
      );
    }
    return { versions, outcomes };
  }

  private enqueue(
    runId: string,
    what: 'version' | 'outcome',
    work: (em: EntityManager) => Promise<void>,
  ): Promise<void> {
    const tail: Promise<void> = (this.queues.get(runId) ?? Promise.resolve())
      .then(() => this.guarded(runId, what, () => work(this.em.fork())))
      .then(() => {
        if (this.queues.get(runId) === tail) {
          this.queues.delete(runId);
        }
      });
    this.queues.set(runId, tail);
    return tail;
  }

  private async recordVersion(runId: string, em: EntityManager): Promise<void> {
    const [run] = await this.runDao.runFacts([runId], em);
    if (run === undefined || run.workflowId === null) {
      return;
    }
    const snapshots = await this.runDao.workflowSnapshots([runId], em);
    await this.stampVersion(run, snapshots.get(runId) ?? null, em);
  }

  private async recordOutcome(runId: string, em: EntityManager): Promise<void> {
    const [run] = await this.runDao.runFacts([runId], em);
    if (run === undefined || run.workflowId === null) {
      return;
    }
    await this.stampOutcome(run, em);
  }

  /**
   * Stamp a run's workflow and version, once. A run with no graph copy it can read is
   * stamped with its workflow alone and stays that way, even when a later read freezes
   * the library's graph into it: that graph is not the one it ran.
   *
   * An inferred version is not registered. Its graph was frozen at some later, unknown
   * time, so its run's creation date says nothing about when the graph was first used,
   * and registering it would number it, and diff its neighbours, out of order.
   */
  private async stampVersion(
    run: RunFacts,
    snapshot: string | null,
    em: EntityManager,
  ): Promise<void> {
    if (run.workflowId === null) {
      return;
    }
    const reading = parseWorkflowSnapshot(snapshot);
    if (reading.state !== 'readable') {
      await this.activityDao.stampThreadVersion(
        run.id,
        run.createdAt,
        { slug: run.workflowId, version: null, inferred: null },
        em,
      );
      return;
    }
    const version = workflowVersionOf(reading.workflow);
    const inferred =
      run.createdAt.getTime() < SNAPSHOT_AT_CREATION_SINCE.getTime();
    if (!inferred) {
      // The graph first, so a stamped version always has its graph to show.
      await this.versionDao.register(
        run.workflowId,
        version,
        canonicalGraphJson(canonicalGraphOf(reading.workflow)),
        run.createdAt,
        em,
      );
    }
    await this.activityDao.stampThreadVersion(
      run.id,
      run.createdAt,
      { slug: run.workflowId, version, inferred },
      em,
    );
  }

  /**
   * Stamp the run as it stands NOW, read after the announce: a run reopened since is
   * left for its next settle, and a run already deleted keeps its previous stamp rather
   * than one read off rows that are gone.
   *
   * A delete cancels the run (a terminal announce) and then purges `node_state`,
   * `wall_turns` and `runs` one after another, so these reads can land mid-purge: the
   * run and its node rows are asked for again after them, and the DAO never lowers the
   * stamped wall time.
   */
  private async stampOutcome(
    run: RunFacts,
    em: EntityManager,
  ): Promise<boolean> {
    if (!isTerminalRunStatus(run.status)) {
      return false;
    }
    // The purge deletes node_state, then wall_turns, then runs. Node rows that were
    // there before the reads and are gone after them mean a read was cut short; a run
    // that never had any (it failed before its nodes were written) is stamped as is.
    const nodesBefore = await this.nodeStateDao.countByRun(run.id, em);
    const failed = await this.nodeStateDao.failedByRuns([run.id], em);
    const wall = await this.wallTurns.runSums([run.id], em);
    if (
      (nodesBefore > 0 &&
        (await this.nodeStateDao.countByRun(run.id, em)) === 0) ||
      (await this.runDao.runFacts([run.id], em)).length === 0
    ) {
      return false;
    }
    await this.activityDao.stampThreadOutcome(
      run.id,
      run.createdAt,
      {
        status: run.status,
        failedNodes: await this.namedNodes(
          run.id,
          failed.map((node) => node.nodeId),
          em,
        ),
        wallMs: wall.get(run.id) ?? 0,
        at: new Date(),
      },
      em,
    );
    return true;
  }

  /** Each failed node with the name its run's own graph gave it, so the name outlives the run. */
  private async namedNodes(
    runId: string,
    nodeIds: readonly string[],
    em: EntityManager,
  ): Promise<FailedNodeStamp[]> {
    if (nodeIds.length === 0) {
      return [];
    }
    const reading = parseWorkflowSnapshot(
      (await this.runDao.workflowSnapshots([runId], em)).get(runId) ?? null,
    );
    const names = new Map(
      reading.state === 'readable'
        ? reading.workflow.nodes.map((node) => [node.id, node.name ?? null])
        : [],
    );
    return [...nodeIds]
      .sort()
      .map((nodeId) => ({ nodeId, name: names.get(nodeId) ?? null }));
  }

  /**
   * Runs one stamp, logging a failure instead of throwing it into the bus or the sweep.
   * True when it wrote; a stamp that answers `false` chose to write nothing.
   */
  private async guarded(
    runId: string,
    what: 'version' | 'outcome',
    stamp: () => Promise<boolean | void>,
  ): Promise<boolean> {
    try {
      return (await stamp()) !== false;
    } catch (err) {
      this.logger.warn(
        `could not stamp the ${what} of workflow run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
