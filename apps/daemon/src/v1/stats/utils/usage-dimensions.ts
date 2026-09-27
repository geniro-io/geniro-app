import { readWorkflowSnapshot } from '../../graphs/utils/workflow-snapshot';
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
 * Gated on `workflowId`: a chat is null here whatever else it carries, since a
 * chat filed in the workflow breakdown is the one thing that breakdown must not
 * contain.
 *
 * The NAME comes from the run's own copy of the workflow (`Run.workflowSnapshot`)
 * and never from the run's TITLE. It was the title, back when the executor
 * stamped every workflow run with its workflow's name; since workflow runs are
 * named after their CONVERSATION like chats are, the title is what the task was
 * about, so one workflow's spend scattered into a row per conversation — and
 * into its slug for the turns before the name landed. The snapshot is taken at
 * run start, so it names the workflow as it was when the run ran, and it is
 * read through the graph module's own reader rather than a second parser of the
 * column. The slug is the fallback for a run with no readable snapshot.
 *
 * The consequence worth knowing: renaming a workflow splits its history at the
 * rename, since each row keeps the name that was true when the turn ran. That
 * is the honest reading — relabelling past spend would restate history the
 * ledger deliberately keeps. For the same reason nothing re-reads rows already
 * written: those recorded while the title was the source keep what they say.
 */
function workflowNameOf(run: Run | null): string | null {
  if (!run || run.workflowId === null) {
    return null;
  }
  return readWorkflowSnapshot(run.workflowSnapshot)?.name ?? run.workflowId;
}
