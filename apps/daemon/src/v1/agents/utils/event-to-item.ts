import type { ItemKind, RunStatus } from '../../runs/runs.types';
import type { AgentEvent } from '../adapters/adapter.types';

/**
 * Shared event→transcript mapping used by both the single-agent chat turn and
 * the graph-node executor, so a normalized `AgentEvent` becomes the same
 * persisted item shape regardless of which flow drove the adapter.
 */

/** One persisted transcript row, before it is given a `seq` and written. */
interface MappedItem {
  kind: ItemKind;
  role: string | null;
  payload: Record<string, unknown>;
}

/**
 * Map a normalized event to the persisted transcript item it becomes.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads back the
 * `parentToolUseId` stamped here. An item payload is `z.unknown()` on the wire
 * BY DESIGN — every kind carries a different shape — so no generated type
 * crosses to the renderer and the two sides are independent readings of one
 * shape. Rename the key here and that file must change with it.
 */
export function mapEventToItem(event: AgentEvent): MappedItem | null {
  const item = mapEventBody(event);
  if (item === null || event.parentToolUseId == null) {
    return item;
  }
  // On the PAYLOAD rather than as a column: it means the same thing for every
  // kind, and a row with no sub-agent origin — the overwhelming majority —
  // carries nothing extra at all.
  return {
    ...item,
    payload: { ...item.payload, parentToolUseId: event.parentToolUseId },
  };
}

function mapEventBody(event: AgentEvent): MappedItem | null {
  switch (event.type) {
    case 'session':
      return null; // captured into node_state, not a transcript item
    case 'slash_commands':
      return null; // captured into the skill-harvest store, not a transcript item
    case 'mcp_servers':
      return null; // captured into the MCP-harvest store, not a transcript item
    case 'turn_model':
      return null; // seeds the live plane's window lookup, not a transcript item
    case 'unhandled_control':
      return null; // logged and dropped by AgentAdapter.start — a diagnostic, not a row
    case 'context_compacted':
      // Deliberately NOT a `system` row. Compaction is the CLI's own
      // housekeeping, and a permanent line about it wedged between the user's
      // messages is noise in the conversation they actually came for. It rides
      // the ephemeral activity channel instead, where it explains the context
      // meter's drop at the moment that drop happens and then goes away.
      return null;
    case 'thinking_progress':
    case 'context_progress':
    case 'text_delta':
      // The EPHEMERAL live plane. This switch has no `default` on purpose:
      // adding an AgentEvent arm breaks the build until someone decides,
      // here, whether it becomes a durable row — which is what stops a
      // per-token delta from ever growing the database.
      return null;
    case 'text':
      return {
        kind: 'message',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        role: 'assistant',
        payload: { id: event.id, name: event.name, input: event.input },
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        role: 'tool',
        payload: {
          id: event.id,
          name: event.name,
          result: event.result,
          isError: event.isError,
        },
      };
    case 'approval_request':
      return {
        kind: 'approval_request',
        role: null,
        payload: {
          id: event.id,
          toolName: event.toolName,
          input: event.input,
          // Persisted for transcript observability (correlates with the
          // daemon's flag-only drift warning); routing AND rendering both
          // key on the tool name, never on this flag.
          ...(event.requiresUserInteraction
            ? { requiresUserInteraction: true }
            : {}),
        },
      };
    case 'turn_complete':
      return {
        kind: 'turn_complete',
        role: null,
        payload: { usage: event.usage, stopReason: event.stopReason },
      };
    case 'notice':
      // Same shape the graph executor persists its own degrade messages in, so
      // an adapter-level degrade renders identically to an executor-level one.
      return {
        kind: 'system',
        role: null,
        payload: { message: event.message },
      };
    case 'turn_cancelled':
      return { kind: 'turn_cancelled', role: null, payload: {} };
    case 'error':
      return {
        kind: 'error',
        role: null,
        // `recovery` rides the payload only when the adapter recognised a cure,
        // so an ordinary failure's row stays byte-identical to what it was.
        //
        // TWIN PARSER: `apps/ui/src/renderer/chats/error-payload.ts` reads this
        // key back. An item payload is `z.unknown()` on the wire BY DESIGN —
        // every kind carries a different shape — so no generated type spans the
        // two sides. Renaming the key here means renaming it there.
        payload: {
          message: event.message,
          ...(event.recovery ? { recovery: event.recovery } : {}),
        },
      };
  }
}

/** The run status a terminal event implies, or null for a mid-turn event. */
export function terminalStatus(event: AgentEvent): RunStatus | null {
  switch (event.type) {
    case 'turn_complete':
      return 'completed';
    case 'error':
      return 'failed';
    case 'turn_cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
