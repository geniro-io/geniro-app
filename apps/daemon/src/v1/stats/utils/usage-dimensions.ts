import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { UsageEventInput } from '../stats.types';

/** The denormalized half of a ledger row — what the turn ran AS. */
export type UsageDimensions = Pick<
  UsageEventInput,
  'agentKind' | 'model' | 'cwd' | 'workflowName'
>;

/**
 * What a turn ran as, read off the run and (for a graph turn) its node.
 *
 * Shared by the live recorder and the boot backfill, which must produce
 * identical rows for the same turn — the backfill's whole job is to fill holes
 * the recorder left, and a row that disagreed with its live twin would make the
 * breakdowns depend on which writer happened to get there first. They had
 * already grown two copies of this expression; a fourth dimension is what makes
 * that a question of when, not whether, they diverge.
 *
 * Copied at write time because every row it is read from is destroyed with the
 * run: a chat delete hard-deletes the run, and a join added later would find
 * nothing.
 *
 * A graph node's own `node_state` wins over the run's fields where it has them:
 * a workflow run names no single agent (its `agentKind` is null) and each node
 * names its own, so reading the run alone would attribute every node's spend to
 * nothing. `cwd` only ever lives on the run — `node_state` stamps none — so it
 * comes from there for both shapes.
 */
export function usageDimensions(
  run: Run | null,
  node: NodeState | null,
): UsageDimensions {
  return {
    agentKind: node?.agentKind ?? run?.agentKind ?? null,
    model: node?.model ?? run?.model ?? null,
    cwd: run?.cwd ?? null,
    workflowName: workflowNameOf(run),
  };
}

/**
 * Which workflow this turn belongs to, or null for a single-agent chat.
 *
 * Gated on `workflowId` and not on `title` alone: a CHAT carries a title too —
 * its conversation name — so taking the title unconditionally would file every
 * chat in the workflow breakdown under its own heading, which is the one thing
 * that breakdown must not contain.
 *
 * The NAME is stored rather than the slug because it is what the user calls the
 * thing; the slug is the fallback for a run recorded before the executor
 * stamped one, and for a workflow whose YAML names none. The consequence worth
 * knowing: renaming a workflow splits its history at the rename, since each row
 * keeps the name that was true when the turn ran. That is the honest reading —
 * the alternative, relabelling past spend, would restate history the ledger
 * deliberately keeps.
 */
function workflowNameOf(run: Run | null): string | null {
  if (!run || run.workflowId === null) {
    return null;
  }
  return run.title ?? run.workflowId;
}
