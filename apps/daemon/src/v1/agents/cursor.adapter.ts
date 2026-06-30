import type {
  AgentEvent,
  AgentUsage,
  Executor,
  ExecutorHandle,
  ExecutorInput,
} from './executor.types';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  firstString,
} from './json-util';
import { runHeadlessCli, type SpawnFn } from './spawn-cli';

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
  return {
    inputTokens: usage
      ? (asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens))
      : null,
    outputTokens: usage
      ? (asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens))
      : null,
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
      });
      return events;
    }

    default:
      return events;
  }
}

export interface CursorExecutorOptions {
  spawn?: SpawnFn;
  logger?: { warn(message: string): void };
}

/**
 * Drives `cursor-agent` headlessly. The prompt is a positional argument (Cursor
 * reads it from argv, not stdin), so stdin is closed immediately — this also
 * prevents the CLI from dropping into its interactive login TTY when
 * unauthenticated; it fails fast instead, surfacing a non-zero exit as an error
 * event. The Cursor key is NOT inherited from the daemon's environment —
 * `spawn-cli` strips every `GENIRO_`-prefixed var (including `GENIRO_CURSOR_API_KEY`)
 * from the child env, and this adapter re-injects it as `CURSOR_API_KEY` for its
 * own child ONLY (see {@link CursorExecutor.start}).
 */
export class CursorExecutor implements Executor {
  readonly kind = 'cursor-agent' as const;

  constructor(private readonly options: CursorExecutorOptions = {}) {}

  start(
    input: ExecutorInput,
    onEvent: (event: AgentEvent) => void,
  ): ExecutorHandle {
    const args = ['-p', '--output-format', 'stream-json', '--force'];
    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.resumeSessionId) {
      args.push('--resume', input.resumeSessionId);
    }
    // End-of-options separator before the positional prompt, so a prompt that
    // starts with `-`/`--` is taken as prompt text rather than parsed as a flag.
    args.push('--', input.prompt);

    // The daemon receives the Keychain-sourced Cursor key as GENIRO_CURSOR_API_KEY
    // (a GENIRO_-prefixed var that spawn-cli strips from every child env). Re-inject
    // it as CURSOR_API_KEY for THIS child only, so the key never reaches the claude
    // agent. Honor an explicit per-call override in input.env if one is given.
    const cursorApiKey = process.env.GENIRO_CURSOR_API_KEY;
    const env: Record<string, string> = {
      ...(cursorApiKey ? { CURSOR_API_KEY: cursorApiKey } : {}),
      ...input.env,
    };

    return runHeadlessCli({
      command: 'cursor-agent',
      args,
      cwd: input.cwd,
      env,
      // No stdin payload — close stdin so an unauthenticated CLI fails fast
      // instead of waiting on an interactive login prompt.
      mapper: mapCursorMessage,
      onEvent,
      spawn: this.options.spawn,
      logger: this.options.logger,
    });
  }
}
