import { resolveAgentBinary } from '../../utils/agent-binary';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  firstString,
} from '../../utils/json-util';
import type { AgentEvent, AgentTurnInput, AgentUsage } from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';

/**
 * Field names `cursor-agent` may use for the resumable chat/session id, across
 * versions. The spec flags Cursor schema drift as HIGH, and `--resume [chatId]`
 * exists but the emitting field is not contract-stable — so we read whichever
 * is present and degrade to a fresh session if none is.
 */
const SESSION_ID_KEYS = [
  'session_id',
  'sessionId',
  'chatId',
  'chat_id',
  'threadId',
  'thread_id',
] as const;

function readUsage(root: Record<string, unknown>): AgentUsage {
  const usage = asRecord(root.usage);
  const inputTokens = usage
    ? (asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens))
    : null;
  return {
    inputTokens,
    outputTokens: usage
      ? (asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens))
      : null,
    // Cursor doesn't break out cache tokens — its input count IS the best
    // available context figure.
    contextTokens: inputTokens,
    costUsd: asNumber(root.total_cost_usd) ?? asNumber(root.cost_usd),
  };
}

/**
 * Map one parsed line of `cursor-agent -p --output-format stream-json`. Written
 * deliberately liberal: Cursor's NDJSON is version-volatile, so this accepts
 * both a Claude-like nested `message.content[]` shape and a flatter `text`
 * shape, reads the session id from any known key, and ignores anything it
 * doesn't recognize rather than failing the turn.
 */
export function mapCursorMessage(obj: unknown): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }

  const type = asString(root.type);
  const sessionId = firstString(root, SESSION_ID_KEYS);
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
            'cursor-agent run failed',
        });
        return events;
      }
      events.push({
        type: 'turn_complete',
        usage: readUsage(root),
        stopReason: asString(root.stop_reason) ?? asString(root.stopReason),
        finalText: asString(root.result) ?? null,
      });
      return events;
    }

    default:
      return events;
  }
}

/**
 * Drives `cursor-agent` headlessly. The prompt is a positional argument (Cursor
 * reads it from argv, not stdin), so stdin is closed immediately — the base
 * class's no-payload default — which also prevents the CLI from dropping into
 * its interactive login TTY when unauthenticated; it fails fast instead,
 * surfacing a non-zero exit as an error event. The Cursor key is NOT inherited
 * from the daemon's environment — `spawn-cli` strips every `GENIRO_`-prefixed
 * var (including `GENIRO_CURSOR_API_KEY`) from the child env, and this adapter
 * re-injects it as `CURSOR_API_KEY` for its own child ONLY (see
 * {@link CursorAdapter.buildEnv}).
 */
export class CursorAdapter extends AgentAdapter {
  readonly kind = 'cursor-agent' as const;

  // Resolved per turn so the Settings cliPaths override (GENIRO_CURSOR_BIN on
  // the daemon env) takes effect without reconstructing the adapter.
  protected get command(): string {
    return resolveAgentBinary('cursor-agent');
  }

  protected buildArgs(input: AgentTurnInput): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--force'];
    if (input.trustWorkspace) {
      args.push('--trust');
    }
    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.resumeSessionId) {
      args.push('--resume', input.resumeSessionId);
    }
    // cursor-agent has no system-prompt flag and no approval callback: a
    // graph node's role is prepended to the prompt text, and `ask` approval
    // degrades to auto-approve (`--force` — the executor surfaces the degrade
    // to the user as a system item).
    const prompt = input.systemPrompt
      ? `${input.systemPrompt}\n\n${input.prompt}`
      : input.prompt;
    // End-of-options separator before the positional prompt, so a prompt that
    // starts with `-`/`--` is taken as prompt text rather than parsed as a flag.
    args.push('--', prompt);
    return args;
  }

  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    // The daemon receives the Keychain-sourced Cursor key as GENIRO_CURSOR_API_KEY
    // (a GENIRO_-prefixed var that spawn-cli strips from every child env). Re-inject
    // it as CURSOR_API_KEY for THIS child only, so the key never reaches the claude
    // agent. Honor an explicit per-call override in input.env if one is given.
    const cursorApiKey = process.env.GENIRO_CURSOR_API_KEY;
    return {
      ...(cursorApiKey ? { CURSOR_API_KEY: cursorApiKey } : {}),
      ...input.env,
    };
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapCursorMessage(obj);
  }
}
