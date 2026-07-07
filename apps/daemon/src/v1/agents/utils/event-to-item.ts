import type { ItemKind, RunStatus } from '../../runs/runs.types';
import type { AgentEvent } from '../adapters/adapter.types';

/**
 * Shared event→transcript mapping used by both the single-agent chat turn and
 * the graph-node executor, so a normalized `AgentEvent` becomes the same
 * persisted item shape regardless of which flow drove the adapter.
 */

/** Map a normalized event to the persisted transcript item it becomes. */
export function mapEventToItem(
  event: AgentEvent,
): { kind: ItemKind; role: string | null; payload: unknown } | null {
  switch (event.type) {
    case 'session':
      return null; // captured into node_state, not a transcript item
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
    case 'turn_cancelled':
      return { kind: 'turn_cancelled', role: null, payload: {} };
    case 'error':
      return { kind: 'error', role: null, payload: { message: event.message } };
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
