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

/**
 * One agent-to-agent call folded into a single nested block: the
 * call_started row becomes the header (callee, mode, ask, LIVE status) and
 * every item of the callee's sub-turn renders inside — so two parallel
 * callees never interleave their messages in the main flow.
 */
export interface CallBlockEntry {
  type: 'call-block';
  /** Stable identity (the call_started item's id) for keys and expansion. */
  id: string;
  callId: string;
  calleeNodeId: string | null;
  /** The caller node the call_started row was attributed to. */
  callerNodeId: string | null;
  mode: string | null;
  message: string | null;
  /** Sub-turn lifecycle, from the callId-tagged status items. */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  entries: TranscriptEntry[];
}

export type TranscriptEntry = ItemEntry | ToolGroupEntry | CallBlockEntry;

/** Caller-side call bookkeeping rows — never claimed into a callee block. */
const CALL_ROW_KINDS = new Set<ChatItem['kind']>([
  'call_started',
  'call_result',
  'call_question',
  'call_answer',
  'await_collected',
]);

/**
 * Kinds that must stay in the MAIN flow even when callId-tagged: the call
 * bookkeeping rows above, plus approval requests/verdicts — a pending card
 * hidden inside a collapsed block could never be answered.
 */
const UNCLAIMABLE_KINDS = new Set<ChatItem['kind']>([
  ...CALL_ROW_KINDS,
  'approval_request',
  'approval_verdict',
]);

const BLOCK_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

/** A pending agent-call block under assembly (one per call_started). */
interface CallShell {
  started: ChatItem;
  calleeNodeId: string | null;
  bucket: ChatItem[];
}

/**
 * Fold a transcript into render entries: agent calls collapse into nested
 * call blocks, tool calls collapse into per-node groups (Claude/Cursor-style
 * "used N tools" rows), everything else stays a plain item entry.
 *
 * Call-block rules:
 * - a `call_started` opens a block; every item TAGGED with that callId and
 *   attributed to the callee node folds inside it (its status items drive
 *   the block's live status instead of rendering as rows — merging the old
 *   redundant "call → B" + "B started" pair into one block header).
 * - caller-side call rows and approval requests/verdicts are never claimed
 *   (see {@link UNCLAIMABLE_KINDS}); untagged items (legacy transcripts)
 *   stay in the main flow.
 *
 * Tool-grouping rules:
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
  // Pass 1 — collect the call shells and claim each callee sub-turn's items.
  const shells = new Map<string, CallShell>();
  for (const item of items) {
    if (item.kind !== 'call_started') {
      continue;
    }
    const callId = payloadString(item.payload, 'callId');
    if (callId && !shells.has(callId)) {
      shells.set(callId, {
        started: item,
        calleeNodeId: payloadString(item.payload, 'calleeNodeId'),
        bucket: [],
      });
    }
  }
  const claimed = new Set<string>();
  if (shells.size > 0) {
    for (const item of items) {
      if (UNCLAIMABLE_KINDS.has(item.kind)) {
        continue;
      }
      const callId = payloadString(item.payload, 'callId');
      const shell = callId ? shells.get(callId) : undefined;
      if (shell && item.nodeId !== null && item.nodeId === shell.calleeNodeId) {
        shell.bucket.push(item);
        claimed.add(item.id);
      }
    }
  }

  // Pass 2 — the main fold over everything not claimed into a block.
  const entries: TranscriptEntry[] = [];
  const hiddenCallIds = new Set<string>();
  const pairsByCallId = new Map<string, ToolPair>();
  const openGroups = new Map<string | null, ToolGroupEntry>();

  for (const item of items) {
    if (claimed.has(item.id)) {
      continue;
    }
    if (item.kind === 'call_started') {
      const callId = payloadString(item.payload, 'callId');
      const shell = callId ? shells.get(callId) : undefined;
      openGroups.delete(item.nodeId);
      if (
        callId &&
        shell &&
        shell.started.id === item.id &&
        shell.bucket.length > 0
      ) {
        entries.push(buildCallBlock(callId, shell));
      } else {
        // No tagged sub-turn yet (a legacy transcript, a call rejected
        // before any turn started, or the spawn racing this render) — keep
        // the flat call row; it upgrades to a block once tagged items land.
        entries.push({ type: 'item', item });
      }
      continue;
    }
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

/**
 * Assemble one call's block: status items drive the header's live status
 * (they never render as rows — the old "▸ B started"/"✓ B finished" pair
 * folds into the header icon), everything else re-folds recursively (tool
 * groups work inside a block; the bucket holds no call rows, so no blocks
 * nest from here).
 */
function buildCallBlock(callId: string, shell: CallShell): CallBlockEntry {
  let status: CallBlockEntry['status'] = 'pending';
  const inner: ChatItem[] = [];
  for (const item of shell.bucket) {
    if (item.kind === 'status') {
      const value = payloadString(item.payload, 'status');
      if (value && BLOCK_STATUSES.has(value)) {
        status = value as CallBlockEntry['status'];
      }
      continue;
    }
    inner.push(item);
  }
  return {
    type: 'call-block',
    id: shell.started.id,
    callId,
    calleeNodeId: shell.calleeNodeId,
    callerNodeId: shell.started.nodeId,
    mode: payloadString(shell.started.payload, 'mode'),
    message: payloadString(shell.started.payload, 'message'),
    status,
    entries: groupTranscript(inner),
  };
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
