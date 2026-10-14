import { agentActionOf } from '../components/agent-action-block';
import {
  isCardEntry,
  type ToolGroupEntry,
  type TranscriptEntry,
} from './transcript-groups';

/**
 * The thread-memory keys of every fold a reader would open, outermost first,
 * to see the row at `seq` — read off the transcript's own structure, so a fold
 * is opened because the row IS in it, never because its seqs happen to span
 * the row's (two delegates of one fan-out interleave theirs). Empty when the
 * row is drawn in no fold, or the transcript does not hold it.
 *
 * TWIN of the memory keys the folds read: `tools:<id>` (`GroupedTools`, one
 * per run of plain calls between agent actions), `tool:<call item id>`
 * (`ToolRow`), `thinking:<item id>` (`ThinkingDisclosure`),
 * `subagent:<block id>` (`SubagentBlock`), `call:<block id>` (`CallBlock`).
 */
export function foldsHolding(
  entries: readonly TranscriptEntry[],
  seq: number,
): string[] {
  for (const entry of entries) {
    const found = foldsIn(entry, seq);
    if (found !== null) {
      return found;
    }
  }
  return [];
}

function foldsIn(entry: TranscriptEntry, seq: number): string[] | null {
  if (entry.type === 'item') {
    if (entry.item.seq !== seq) {
      return null;
    }
    return entry.item.kind === 'reasoning' ? [`thinking:${entry.item.id}`] : [];
  }
  if (entry.type === 'tools') {
    return foldsInTools(entry, seq);
  }
  if (isCardEntry(entry)) {
    return entry.seq === seq ? [] : null;
  }
  const inner = foldsHolding(entry.entries, seq);
  if (inner.length === 0 && !holds(entry.entries, seq)) {
    return null;
  }
  if (entry.type === 'subagent-block') {
    return [`subagent:${entry.id}`, ...inner];
  }
  if (entry.type === 'call-block') {
    return [`call:${entry.id}`, ...inner];
  }
  return inner;
}

/** Whether a row at `seq` is drawn among `entries`, in a fold or not. */
function holds(entries: readonly TranscriptEntry[], seq: number): boolean {
  return entries.some((entry) => foldsIn(entry, seq) !== null);
}

/**
 * A tool group draws its plain calls in runs between agent actions, each run
 * its own fold keyed by its first call — `ToolGroup`'s own split.
 */
function foldsInTools(group: ToolGroupEntry, seq: number): string[] | null {
  let runStart: string | null = null;
  for (const pair of group.pairs) {
    const action = agentActionOf(pair) !== null;
    if (action) {
      runStart = null;
    } else {
      runStart ??= pair.call.id;
    }
    if (pair.call.seq !== seq && pair.result?.seq !== seq) {
      continue;
    }
    return action ? [] : [`tools:${runStart!}`, `tool:${pair.call.id}`];
  }
  return null;
}
