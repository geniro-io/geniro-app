import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  firstString,
} from '../../../utils/json-util';
import type { AgentEvent } from '../../adapter.types';
import {
  CURSOR_RUN_FAILED_MESSAGE,
  CURSOR_SESSION_ID_KEYS,
} from '../cursor.const';
import { readCursorUsage } from './cursor-usage.utils';

/**
 * Map one parsed line of `cursor-agent -p --output-format stream-json`. Written
 * deliberately liberal: Cursor's NDJSON is version-volatile, so this accepts
 * both a Claude-like nested `message.content[]` shape and a flatter `text`
 * shape, reads the session id from any known key, and ignores anything it
 * doesn't recognize rather than failing the turn.
 *
 * An exported pure function rather than a method: `CursorAdapter.mapMessage` is
 * a one-line delegate, so every shape above is drivable from a spec without
 * spawning a process.
 */
export function mapCursorMessage(obj: unknown): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }

  const type = asString(root.type);
  const sessionId = firstString(root, CURSOR_SESSION_ID_KEYS);
  const events: AgentEvent[] = [];

  if (type === 'system') {
    return sessionId ? [{ type: 'session', sessionId }] : [];
  }
  // A session id can ride on a non-system event in some versions; surface it
  // (the service captures it idempotently) without swallowing the real payload.
  if (sessionId) {
    events.push({ type: 'session', sessionId });
  }

  switch (type) {
    case 'assistant': {
      const message = asRecord(root.message);
      const content = asArray(message?.content ?? root.content);
      if (content.length > 0) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b) {
            continue;
          }
          switch (asString(b.type)) {
            case 'text': {
              const text = asString(b.text);
              if (text) {
                events.push({ type: 'text', text });
              }
              break;
            }
            case 'thinking':
            case 'reasoning': {
              const text = asString(b.thinking) ?? asString(b.text);
              if (text) {
                events.push({ type: 'reasoning', text });
              }
              break;
            }
            case 'tool_use':
            case 'tool_call': {
              events.push({
                type: 'tool_call',
                id: asString(b.id) ?? '',
                name: asString(b.name) ?? '',
                input: b.input ?? null,
              });
              break;
            }
            default:
              break;
          }
        }
      } else {
        const text =
          asString(root.text) ??
          asString(message?.text) ??
          asString(root.content);
        if (text) {
          events.push({ type: 'text', text });
        }
      }
      return events;
    }

    case 'thinking':
    case 'reasoning': {
      const text = asString(root.text) ?? asString(root.thinking);
      if (text) {
        events.push({ type: 'reasoning', text });
      }
      return events;
    }

    case 'tool_call':
    case 'tool_use': {
      events.push({
        type: 'tool_call',
        id: asString(root.id) ?? '',
        name: asString(root.name) ?? '',
        input: root.input ?? null,
      });
      return events;
    }

    case 'tool_result': {
      events.push({
        type: 'tool_result',
        id: asString(root.tool_use_id) ?? asString(root.id) ?? '',
        name: asString(root.name),
        result: root.content ?? root.result ?? null,
        isError: asBoolean(root.is_error),
      });
      return events;
    }

    case 'user': {
      const message = asRecord(root.message);
      for (const block of asArray(message?.content ?? root.content)) {
        const b = asRecord(block);
        if (b && asString(b.type) === 'tool_result') {
          events.push({
            type: 'tool_result',
            id: asString(b.tool_use_id) ?? '',
            name: null,
            result: b.content ?? null,
            isError: asBoolean(b.is_error),
          });
        }
      }
      return events;
    }

    case 'result': {
      if (asBoolean(root.is_error)) {
        events.push({
          type: 'error',
          message:
            asString(root.result) ??
            asString(root.error) ??
            CURSOR_RUN_FAILED_MESSAGE,
        });
        return events;
      }
      events.push({
        type: 'turn_complete',
        usage: readCursorUsage(root),
        stopReason: asString(root.stop_reason) ?? asString(root.stopReason),
        finalText: asString(root.result) ?? null,
      });
      return events;
    }

    default:
      return events;
  }
}
