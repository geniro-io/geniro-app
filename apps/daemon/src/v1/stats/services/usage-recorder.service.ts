import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { ItemWire } from '../../agents/chat.types';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { usageFiguresFrom } from '../../agents/utils/usage-figures';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEventInput } from '../stats.types';

/**
 * Copies every finished turn's usage into the ledger as it happens.
 *
 * **It observes the agent plane and never drives it** — the same direction, and
 * for the same reason, as `DiagnosticsModule`: the bus is where BOTH execution
 * paths converge (a chat turn and the graph executor publish through the one
 * `persistItemAndEmit`), so a single subscription covers both and neither has to
 * remember that a ledger exists. Nothing in `v1/agents` imports this module, so
 * the dependency is one-way — though not zero: `ItemDao.allTurnCompleteRows` and
 * `Item`'s `kind` index were added there for the boot sweep and serve nothing
 * else.
 *
 * The bus publishes AFTER the row is durable (persist-then-emit), so a recorded
 * event always has a transcript row behind it. The reverse is not guaranteed: a
 * daemon that dies between the item write and this write leaves that one turn
 * unrecorded, which is what the boot backfill exists to repair.
 */
@Injectable()
export class UsageRecorderService implements OnModuleInit {
  private readonly logger = new Logger(UsageRecorderService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly usageDao: UsageEventDao,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (event.item.kind !== 'turn_complete') {
        return;
      }
      // Fire-and-forget with the failure OWNED here: this is an RxJS subscriber,
      // so a rejection escaping it would surface as an unhandled rejection and
      // reach the process-level crash guard — a lost accounting row must not be
      // able to take the daemon's turn plumbing with it.
      void this.record(event.runId, event.item).catch((err) => {
        this.logger.warn(
          `failed to record usage for run ${event.runId} seq ${event.item.seq}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
  }

  /**
   * Project one `turn_complete` item into a ledger row and write it, unless the
   * ledger already holds that turn.
   *
   * A turn that reported no usage writes nothing at all. A zero-filled row
   * would be indistinguishable from a turn that genuinely cost nothing, and the
   * per-day averages would then be diluted by turns that never reported.
   */
  private async record(runId: string, item: ItemWire): Promise<void> {
    const figures = usageFiguresFrom(item.payload);
    if (!figures) {
      return;
    }
    const em = this.em.fork();
    const row: UsageEventInput = {
      runId,
      nodeId: item.nodeId,
      seq: item.seq,
      occurredAt: new Date(item.createdAt),
      ...(await this.dimensions(runId, item.nodeId, em)),
      ...figures,
    };
    await this.usageDao.recordOnce(row, em);
  }

  /**
   * What this turn ran as, copied at write time because the rows that hold it
   * are destroyed with the run.
   *
   * A graph node's own `node_state` wins over the run's fields where it has
   * them: a workflow run names no single agent (its `agentKind` is null) and
   * each node names its own, so reading the run alone would attribute every
   * node's spend to nothing. `cwd` only ever lives on the run — `node_state`
   * stamps none — so it comes from there for both shapes.
   */
  private async dimensions(
    runId: string,
    nodeId: string | null,
    em: EntityManager,
  ): Promise<Pick<UsageEventInput, 'agentKind' | 'model' | 'cwd'>> {
    const run = await this.runDao.getById(runId, em);
    const node =
      nodeId === null
        ? null
        : await this.nodeStateDao.getByRunNode(runId, nodeId, em);
    return {
      agentKind: node?.agentKind ?? run?.agentKind ?? null,
      model: node?.model ?? run?.model ?? null,
      cwd: run?.cwd ?? null,
    };
  }
}
