import type { ChatItem } from '../../shared/contracts';
import { payloadString } from './transcript-item';

/**
 * The renderer's own agent-call tools ride the transcript as raw
 * tool_call/tool_result items too, but the dedicated call kinds
 * (call_started/call_result/call_question/call_answer/await_collected)
 * already tell that story in a readable form — the raw envelope JSON rows
 * are pure duplication, so they are hidden from the transcript.
 */
const GENIRO_TOOL_PREFIX = 'mcp__geniro__';

/** One tool invocation: its call and (once it arrived) its paired result. */
export interface ToolPair {
  call: ChatItem;
  result: ChatItem | null;
}

/** A run of tool calls collapsed into one expandable transcript row. */
export interface ToolGroupEntry {
  type: 'tools';
  /** Stable identity for React keys and expansion state: the first call's id. */
  id: string;
  nodeId: string | null;
  pairs: ToolPair[];
}

export interface ItemEntry {
  type: 'item';
  item: ChatItem;
}

export type TranscriptEntry = ItemEntry | ToolGroupEntry;

/**
 * Fold a transcript into render entries: tool calls collapse into per-node
 * groups (Claude/Cursor-style "used N tools" rows), everything else stays a
 * plain item entry.
 *
 * Grouping rules:
 * - a `tool_call` joins its node's OPEN group (or opens one); any other
 *   rendered kind from the SAME node closes that node's group — another
 *   node's interleaved rows do not, so a parallel branch doesn't shred the
 *   caller's tool run into fragments.
 * - a `tool_result` attaches to its call by payload id wherever that call
 *   lives (the pairing survives a closed group); an orphan result (no known
 *   call) stays a plain item entry.
 * - `mcp__geniro__*` tool calls and their results are dropped entirely (see
 *   {@link GENIRO_TOOL_PREFIX}).
 */
export function groupTranscript(items: readonly ChatItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const hiddenCallIds = new Set<string>();
  const pairsByCallId = new Map<string, ToolPair>();
  const openGroups = new Map<string | null, ToolGroupEntry>();

  for (const item of items) {
    if (item.kind === 'tool_call') {
      const name = payloadString(item.payload, 'name') ?? '';
      const callId = payloadString(item.payload, 'id');
      if (name.startsWith(GENIRO_TOOL_PREFIX)) {
        if (callId) {
          hiddenCallIds.add(callId);
        }
        continue;
      }
      const pair: ToolPair = { call: item, result: null };
      if (callId) {
        pairsByCallId.set(callId, pair);
      }
      const open = openGroups.get(item.nodeId);
      if (open) {
        open.pairs.push(pair);
      } else {
        const group: ToolGroupEntry = {
          type: 'tools',
          id: item.id,
          nodeId: item.nodeId,
          pairs: [pair],
        };
        openGroups.set(item.nodeId, group);
        entries.push(group);
      }
      continue;
    }
    if (item.kind === 'tool_result') {
      const callId = payloadString(item.payload, 'id');
      if (callId && hiddenCallIds.has(callId)) {
        continue;
      }
      const pair = callId ? pairsByCallId.get(callId) : undefined;
      if (pair) {
        pair.result = item;
        continue;
      }
      entries.push({ type: 'item', item });
      continue;
    }
    // Any other rendered kind from this node is a narrative boundary — the
    // node "said something", so its next tool call starts a fresh group.
    openGroups.delete(item.nodeId);
    entries.push({ type: 'item', item });
  }
  return entries;
}

/** File-touching tools, for the group summary's edit/create counts. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The collapsed group's one-line summary, Claude/Cursor-style:
 * "Used 5 tools · ran 2 commands · edited 1 file".
 */
export function toolGroupSummary(pairs: readonly ToolPair[]): string {
  let commands = 0;
  const edited = new Set<string>();
  const created = new Set<string>();
  for (const { call } of pairs) {
    const name = payloadString(call.payload, 'name') ?? '';
    const input = (call.payload as { input?: unknown } | null)?.input;
    const file =
      input && typeof input === 'object' && 'file_path' in input
        ? String((input as { file_path: unknown }).file_path)
        : null;
    if (name === 'Bash') {
      commands += 1;
    } else if (EDIT_TOOLS.has(name) && file) {
      edited.add(file);
    } else if (name === 'Write' && file) {
      created.add(file);
    }
  }
  const count = (n: number, noun: string): string =>
    `${n} ${noun}${n === 1 ? '' : 's'}`;
  const parts = [`Used ${count(pairs.length, 'tool')}`];
  if (commands > 0) {
    parts.push(`ran ${count(commands, 'command')}`);
  }
  if (edited.size > 0) {
    parts.push(`edited ${count(edited.size, 'file')}`);
  }
  if (created.size > 0) {
    parts.push(`created ${count(created.size, 'file')}`);
  }
  return parts.join(' · ');
}

/** One-line argument preview for a tool row (the command, the path, …). */
export function toolCallSummary(call: ChatItem): string {
  const input = (call.payload as { input?: unknown } | null)?.input;
  if (!input || typeof input !== 'object') {
    return '';
  }
  const record = input as Record<string, unknown>;
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  };
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const q = questions[0] as { question?: unknown };
    if (typeof q?.question === 'string') {
      return q.question;
    }
  }
  return (
    first(
      'command',
      'file_path',
      'pattern',
      'description',
      'query',
      'prompt',
      'path',
      'url',
    ) ?? compactJson(record)
  );
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Flatten a tool_result payload's `result` for display: strings pass
 * through, Claude's `[{type:'text',text}]` block arrays join their text,
 * anything else pretty-prints as JSON.
 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : null,
      )
      .filter((text): text is string => text !== null);
    if (texts.length > 0 && texts.length === result.length) {
      return texts.join('\n');
    }
  }
  try {
    return JSON.stringify(result, null, 2) ?? '';
  } catch {
    return String(result);
  }
}
