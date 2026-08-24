import type { EntityManager } from '@mikro-orm/sqlite';

import type { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import type { ItemWire, RunAwaiting, RunWire } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { AgentEventBus } from '../services/agent-events.bus';

/**
 * The one persist-then-emit implementation both execution paths (single-agent
 * chat and the graph executor) share: write the row — allocating its place in
 * the run's monotonic `seq` order — THEN publish on the bus, so SQLite stays
 * the source of truth and a reconnecting client can replay everything it
 * missed. Also clears the forked EntityManager's identity map afterwards, so
 * a long streaming run doesn't grow it unboundedly.
 */
export async function persistItemAndEmit(
  deps: { itemDao: ItemDao; bus: AgentEventBus },
  em: EntityManager,
  row: {
    runId: string;
    nodeId: string | null;
    seq: number;
    kind: ItemKind;
    role: string | null;
    payload: unknown;
  },
): Promise<ItemWire> {
  const item = await deps.itemDao.create(
    {
      runId: row.runId,
      nodeId: row.nodeId,
      seq: row.seq,
      kind: row.kind,
      role: row.role,
      payload: JSON.stringify(row.payload),
    },
    em,
  );
  const wire: ItemWire = {
    id: item.id,
    runId: row.runId,
    nodeId: row.nodeId,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    payload: row.payload,
    createdAt: item.createdAt.toISOString(),
  };
  deps.bus.publish({ runId: row.runId, item: wire });
  em.clear();
  return wire;
}

/** The one Run → wire projection (chat and workflow runs share the shape). */
export function runToWire(
  run: Run,
  lastMessage: string | null = null,
  /**
   * What the run is parked on right now, from the approval registry.
   *
   * Passed in rather than looked up here: this is a pure projection of a row,
   * and the registry is in-memory DI state. Defaulted to null so the paths
   * that genuinely cannot be parked — a run being created, a workflow run just
   * started — say so without asking.
   */
  awaiting: RunAwaiting | null = null,
  /**
   * How many units of background work this run's turn is being held for, from
   * the live turn state.
   *
   * Passed in for the same reason {@link awaiting} is — a pure projection of a
   * row cannot read in-memory state — and on the ROW for the same reason too: a
   * hold lasts as long as the delegates do, which is minutes, and the announce
   * that starts it is a one-off event. Without it a window opened (or a chat
   * revisited) mid-hold reads the run as a working agent and puts the user's
   * message back in the queue.
   */
  holdingFor = 0,
): RunWire {
  return {
    id: run.id,
    status: run.status,
    awaiting,
    holdingFor,
    title: run.title,
    agentKind: run.agentKind,
    workflowId: run.workflowId,
    cwd: run.cwd,
    model: run.model,
    approval: run.approval,
    effort: run.effort,
    contextWindow: run.contextWindow,
    contextTokens: run.contextTokens,
    contextWindowTokens: run.contextWindowTokens,
    configDir: run.configDir,
    groupId: run.groupId,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    lastMessage,
  };
}
