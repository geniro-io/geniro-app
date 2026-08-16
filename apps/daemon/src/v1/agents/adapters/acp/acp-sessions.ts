import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type { AgentEvent, AgentSessionRecord } from '../adapter.types';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
} from './acp.types';
import {
  classifyMessage,
  encodeRequest,
  type IncomingMessage,
} from './acp-jsonrpc';

/**
 * `session/list` — the protocol's own answer to "what conversations do you
 * hold", asked with a two-frame handshake and no session of its own.
 *
 * Agent-agnostic like the rest of `adapters/acp/`: the method, the reply shape
 * and the capability flag are ACP's, so a second ACP-capable CLI gets this
 * listing by composing the same client rather than by writing one.
 *
 * The reply carries `{sessionId, cwd, title, updatedAt}` per row — including a
 * title the AGENT generated, which is the one field a disk scan could never
 * produce. Probed 2026-08-16 against cursor-agent 2026.08.11-e8db854, with and
 * without the `cwd` filter, and against a fresh empty config directory (which
 * answers with zero rows — so the listing is profile-scoped, not a global
 * index, and the profile this is asked under decides what comes back).
 */

/** Ids for the two frames, distinct so a reply cannot be mistaken for the other. */
const LIST_INITIALIZE_ID = 1;
const LIST_SESSIONS_ID = 2;
/** Distinct from the listing's, so the two handshakes cannot share a reader. */
const LOAD_SESSION_ID = 3;

/**
 * The handshake: `initialize`, then `session/list`.
 *
 * No `session/new`, unlike the model probe — this asks about conversations
 * that already exist and must not create one to do it. That is also why it is
 * cheap enough to run on every open of the picker.
 */
export function acpSessionListFrames(input: {
  cwd: string | null;
  clientName: string;
  clientVersion: string;
  clientMeta?: Readonly<Record<string, unknown>>;
}): string[] {
  return [
    encodeRequest(LIST_INITIALIZE_ID, ACP_AGENT_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(input.clientMeta ? { _meta: input.clientMeta } : {}),
      },
      clientInfo: { name: input.clientName, version: input.clientVersion },
    }),
    encodeRequest(
      LIST_SESSIONS_ID,
      ACP_AGENT_METHODS.sessionList,
      // The filter is the agent's to apply. Sent only when there is one: an
      // explicit `cwd: null` is a parameter with a value, and an agent
      // validating its params would be within its rights to refuse it.
      input.cwd === null ? {} : { cwd: input.cwd },
    ),
  ];
}

/**
 * The listing reply once it has arrived.
 *
 * An ERROR reply settles too, with a null result — an agent that does not
 * implement the method answers `-32601` at once, and waiting out the deadline
 * to report the same empty list serves nobody.
 */
function sessionListReply(stdout: string): {
  settled: boolean;
  result: unknown;
} {
  for (const message of eachMessage(stdout)) {
    if (message.kind === 'response' && message.id === LIST_SESSIONS_ID) {
      return { settled: true, result: message.result };
    }
    if (message.kind === 'error' && message.id === LIST_SESSIONS_ID) {
      return { settled: true, result: null };
    }
  }
  return { settled: false, result: null };
}

/** Whether {@link acpSessionListFrames}' answer is fully on stdout yet. */
export function acpSessionListSettled(stdout: string): boolean {
  return sessionListReply(stdout).settled;
}

/**
 * The sessions a completed listing reported, newest first.
 *
 * Read defensively, one row at a time: a row missing its id is skipped rather
 * than failing the listing, because one malformed entry must not cost the user
 * every other conversation they have. `updatedAt` is an ISO-8601 string in the
 * schema and is accepted as a number too — an epoch is what the rest of the app
 * carries, and an agent sending one should not have its rows silently undated.
 */
export function readAcpSessionList(stdout: string): AgentSessionRecord[] {
  const rows: AgentSessionRecord[] = [];
  for (const entry of asArray(
    asRecord(sessionListReply(stdout).result)?.sessions,
  )) {
    const record = asRecord(entry);
    const id = record ? asString(record.sessionId) : null;
    if (record === null || id === null || id === '') {
      continue;
    }
    rows.push({
      id,
      cwd: asString(record.cwd) || null,
      title: asString(record.title) || null,
      updatedAt: readTimestamp(record.updatedAt),
    });
  }
  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return rows;
}

/**
 * The frames that make the agent hand back one conversation: `initialize`, then
 * `session/load`.
 *
 * No prompt follows, and that is the point — `session/load` replays the ENTIRE
 * prior conversation as `session/update` notifications before its own reply
 * lands, so the transcript can be collected without the agent being asked to
 * think about anything. Probed 2026-08-16 on 2026.08.11-e8db854: a load of a
 * copied session streamed its user messages, its thoughts and its answers, then
 * replied.
 *
 * Reading it HERE rather than on the thread's first turn is what keeps the
 * order right. A turn's replay arrives after the user's new message has already
 * been persisted, so the imported history would sit BELOW the message that
 * continued it.
 */
export function acpSessionLoadFrames(input: {
  sessionId: string;
  cwd: string;
  clientName: string;
  clientVersion: string;
  clientMeta?: Readonly<Record<string, unknown>>;
}): string[] {
  return [
    encodeRequest(LIST_INITIALIZE_ID, ACP_AGENT_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(input.clientMeta ? { _meta: input.clientMeta } : {}),
      },
      clientInfo: { name: input.clientName, version: input.clientVersion },
    }),
    encodeRequest(LOAD_SESSION_ID, ACP_AGENT_METHODS.sessionLoad, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      // No MCP servers. This session is being READ, and dialling the folder's
      // servers to do it would start every one of the user's own processes for
      // a transcript nobody is going to act on.
      mcpServers: [],
    }),
  ];
}

/** Whether {@link acpSessionLoadFrames}' load has answered yet. */
export function acpSessionLoadSettled(stdout: string): boolean {
  for (const message of eachMessage(stdout)) {
    if (
      (message.kind === 'response' || message.kind === 'error') &&
      message.id === LOAD_SESSION_ID
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The conversation a completed load replayed, oldest first.
 *
 * A deliberately SMALLER reading than the per-turn driver's: this is a record
 * of something that already happened, so what it needs to carry is what was
 * said — the two sides of the conversation, the agent's reasoning, and the
 * tools it reached for. Everything the driver's mapper additionally tracks
 * (live deltas, permission round-trips, delegate blocks, usage) belongs to a
 * turn in flight and has no meaning in a replay.
 *
 * Chunks are joined into blocks the same way the driver joins them, and for the
 * same reason: ACP sends a message as a run of chunks with no "block complete"
 * frame, so emitting one row per chunk writes a paragraph per word.
 */
export function readAcpSessionReplay(stdout: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  let pending: { kind: PendingKind; parts: string[] } | null = null;
  const flush = (): void => {
    if (pending === null) {
      return;
    }
    const text = pending.parts.join('');
    const kind = pending.kind;
    pending = null;
    if (text !== '') {
      events.push({ type: kind, text });
    }
  };
  const append = (kind: PendingKind, text: string): void => {
    if (pending !== null && pending.kind !== kind) {
      flush();
    }
    pending ??= { kind, parts: [] };
    pending.parts.push(text);
  };

  for (const message of eachMessage(stdout)) {
    if (
      message.kind !== 'notification' ||
      message.method !== ACP_CLIENT_METHODS.sessionUpdate
    ) {
      continue;
    }
    const update = asRecord(asRecord(message.params)?.update);
    if (update === null) {
      continue;
    }
    switch (asString(update.sessionUpdate)) {
      case 'user_message_chunk':
        append('user_message', textOfContent(update.content));
        break;
      case 'agent_message_chunk':
        append('text', textOfContent(update.content));
        break;
      case 'agent_thought_chunk':
        append('reasoning', textOfContent(update.content));
        break;
      case 'tool_call': {
        // A tool call ends whatever was being said, exactly as it does live —
        // that is what keeps "said something → used a tool → said something"
        // readable rather than collapsed into one block.
        flush();
        const id = asString(update.toolCallId);
        const title = asString(update.title);
        if (id !== null) {
          events.push({
            type: 'tool_call',
            id,
            // ACP gives a tool call a human title and no machine name; the
            // title is what the row shows either way.
            name: title ?? '',
            input: update.rawInput ?? null,
            ...(asString(update.kind) === null
              ? {}
              : { kind: asString(update.kind) as string }),
          });
        }
        break;
      }
      default:
        // tool_call_update (a live status this record has no use for),
        // plan/plan_update, available_commands_update, usage_update — none of
        // them say anything about what the conversation WAS.
        break;
    }
  }
  flush();
  return events;
}

/** The event an open run of replayed chunks becomes when it closes. */
type PendingKind = 'user_message' | 'text' | 'reasoning';

/** The text of an ACP content block, or '' for a shape carrying none. */
function textOfContent(content: unknown): string {
  const record = asRecord(content);
  if (record === null || asString(record.type) !== 'text') {
    return '';
  }
  return asString(record.text) ?? '';
}

/** Every parseable JSON-RPC message on a captured stdout, in order. */
function* eachMessage(stdout: string): Generator<IncomingMessage> {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial trailing line, or the agent's own non-JSON chatter.
      continue;
    }
    yield classifyMessage(parsed);
  }
}

/** Epoch ms from either carrier, or null when the value is neither. */
function readTimestamp(value: unknown): number | null {
  const asNumeric = asNumber(value);
  if (asNumeric !== null) {
    return asNumeric;
  }
  const text = asString(value);
  if (text === null) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}
