import type {
  AgentEvent,
  AgentUsage,
  Executor,
  ExecutorHandle,
  ExecutorInput,
} from './executor.types';
import { asArray, asBoolean, asNumber, asRecord, asString } from './json-util';
import { runHeadlessCli, type SpawnFn } from './spawn-cli';

/**
 * Map one parsed line of `claude -p --output-format stream-json` to normalized
 * events. Shapes verified against a live `claude` 2.1.196 capture:
 * - `system/init` carries the `session_id` (→ resume slot).
 * - `assistant.message.content[]` blocks: `text` / `thinking` / `tool_use`.
 * - `user.message.content[]` `tool_result` blocks close a tool call.
 * - `result` carries the final text, `usage`, `total_cost_usd`, `stop_reason`.
 * - Anything else (`hook_*`, `post_turn_summary`, `rate_limit_event`, …) is
 *   ignored — the stream legitimately includes event types this turn doesn't model.
 */
export function mapClaudeMessage(obj: unknown): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }

  switch (asString(root.type)) {
    case 'system': {
      if (asString(root.subtype) === 'init') {
        const sessionId = asString(root.session_id);
        return sessionId ? [{ type: 'session', sessionId }] : [];
      }
      return [];
    }

    case 'assistant': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      const events: AgentEvent[] = [];
      for (const block of asArray(message.content)) {
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
          case 'thinking': {
            const text = asString(b.thinking) ?? asString(b.text);
            if (text) {
              events.push({ type: 'reasoning', text });
            }
            break;
          }
          case 'tool_use': {
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
      return events;
    }

    case 'user': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      const events: AgentEvent[] = [];
      for (const block of asArray(message.content)) {
        const b = asRecord(block);
        if (!b || asString(b.type) !== 'tool_result') {
          continue;
        }
        events.push({
          type: 'tool_result',
          id: asString(b.tool_use_id) ?? '',
          name: null,
          result: b.content ?? null,
          isError: asBoolean(b.is_error),
        });
      }
      return events;
    }

    case 'result': {
      if (asBoolean(root.is_error)) {
        return [
          {
            type: 'error',
            message:
              asString(root.result) ??
              asString(root.error) ??
              'claude run failed',
          },
        ];
      }
      const usageRec = asRecord(root.usage);
      const usage: AgentUsage = {
        inputTokens: usageRec ? asNumber(usageRec.input_tokens) : null,
        outputTokens: usageRec ? asNumber(usageRec.output_tokens) : null,
        costUsd: asNumber(root.total_cost_usd),
      };
      return [
        {
          type: 'turn_complete',
          usage,
          stopReason: asString(root.stop_reason),
        },
      ];
    }

    default:
      return [];
  }
}

export interface ClaudeExecutorOptions {
  spawn?: SpawnFn;
  logger?: { warn(message: string): void };
}

/**
 * Drives `claude` headlessly. The prompt is sent as a stream-json user-message
 * line on stdin (`--input-format stream-json`); `--verbose` is required for
 * stream-json output. Resume passes the prior `session_id` via `--resume`.
 */
export class ClaudeExecutor implements Executor {
  readonly kind = 'claude' as const;

  constructor(private readonly options: ClaudeExecutorOptions = {}) {}

  start(
    input: ExecutorInput,
    onEvent: (event: AgentEvent) => void,
  ): ExecutorHandle {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ];
    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.resumeSessionId) {
      args.push('--resume', input.resumeSessionId);
    }

    const stdinPayload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
      },
    })}\n`;

    return runHeadlessCli({
      command: 'claude',
      args,
      cwd: input.cwd,
      env: input.env,
      stdinPayload,
      mapper: mapClaudeMessage,
      onEvent,
      spawn: this.options.spawn,
      logger: this.options.logger,
    });
  }
}
