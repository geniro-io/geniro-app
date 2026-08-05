import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type { AgentEvent } from '../../adapter.types';
import { CLAUDE_RUN_FAILED_MESSAGE } from '../claude.const';
import {
  readClaudeAssistantContext,
  readClaudeUsage,
} from './claude-usage.utils';

/**
 * Map one parsed line of `claude -p --output-format stream-json` to normalized
 * events. Shapes verified against a live `claude` 2.1.196 capture:
 * - `system/init` carries the `session_id` (→ resume slot).
 * - `assistant.message.content[]` blocks: `text` / `thinking` / `tool_use`.
 * - `user.message.content[]` `tool_result` blocks close a tool call.
 * - `result` carries the final text, `usage`, `total_cost_usd`, `stop_reason`.
 * - `control_request` (`can_use_tool`) is the permission pause of the stdin
 *   control protocol (`--permission-prompt-tool stdio`, `ask` approval mode);
 *   verified against a live 2.1.199 capture.
 * - Anything else (`hook_*`, `post_turn_summary`, `rate_limit_event`, …) is
 *   ignored — the stream legitimately includes event types this turn doesn't model.
 *
 * An exported pure function rather than a method: `ClaudeAdapter.mapMessage` is
 * a one-line delegate, so every shape above is drivable from a spec without
 * spawning a process.
 */
export function mapClaudeMessage(obj: unknown): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }

  switch (asString(root.type)) {
    case 'system': {
      if (asString(root.subtype) === 'thinking_tokens') {
        return mapClaudeThinkingTokens(root);
      }
      if (asString(root.subtype) === 'init') {
        const events: AgentEvent[] = [];
        const sessionId = asString(root.session_id);
        if (sessionId) {
          events.push({ type: 'session', sessionId });
        }
        // init's `slash_commands` is the session's authoritative invokable
        // set (built-ins + plugins + skills + commands) — harvested for the
        // composer's `/` autocomplete. Verified live on 2.1.211.
        const commands = asArray(root.slash_commands)
          .map((entry) => asString(entry))
          .filter((entry): entry is string => entry !== null && entry !== '');
        if (commands.length > 0) {
          events.push({ type: 'slash_commands', commands });
        }
        // The only line before `result` that names the model. `assistant`
        // lines carry the CANONICAL id (`claude-opus-5`), which is not the key
        // `result.modelUsage` is keyed by (`claude-opus-5[1m]`) — so init's is
        // the one that can match a remembered window. Verified on 2.1.220.
        const model = asString(root.model);
        if (model) {
          events.push({ type: 'turn_model', model });
        }
        return events;
      }
      return [];
    }

    case 'stream_event':
      return mapClaudeStreamEvent(root);

    case 'assistant': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      const events: AgentEvent[] = [];
      // Lifted BEFORE the content blocks so the meter moves as soon as the
      // request lands, rather than trailing the words it produced.
      const contextTokens = readClaudeAssistantContext(message);
      if (contextTokens !== null) {
        events.push({ type: 'context_progress', contextTokens });
      }
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

    case 'control_request': {
      const request = asRecord(root.request);
      const id = asString(root.request_id);
      const subtype = request ? asString(request.subtype) : null;
      if (!request || !id || subtype !== 'can_use_tool') {
        // Not a bare drop: the subtype travels back as data so the caller can
        // log it. This mapper is pure by contract, so a subtype the adapter
        // does not model is invisible unless it leaves the function.
        return [{ type: 'unhandled_control', subtype: subtype ?? '<none>' }];
      }
      return [
        {
          type: 'approval_request',
          id,
          toolName: asString(request.tool_name) ?? '',
          input: request.input ?? null,
          // AskUserQuestion carries requires_user_interaction: true — the M4
          // question-vs-permission discriminator. Verified live on 2.1.202 and
          // re-probed on 2.1.220 (2026-07-29).
          requiresUserInteraction: asBoolean(request.requires_user_interaction)
            ? true
            : undefined,
        },
      ];
    }

    case 'result': {
      if (asBoolean(root.is_error)) {
        return [
          {
            type: 'error',
            message:
              asString(root.result) ??
              asString(root.error) ??
              CLAUDE_RUN_FAILED_MESSAGE,
          },
        ];
      }
      return [
        {
          type: 'turn_complete',
          usage: readClaudeUsage(root),
          stopReason: asString(root.stop_reason),
          finalText: asString(root.result) ?? null,
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Map one `stream_event` line to a live text increment, or [] to ignore it.
 *
 * With `CLAUDE_PARTIAL_MESSAGES_FLAG` (`claude.const.ts`) the CLI interleaves
 * `stream_event` lines with the ordinary ones; the completed `assistant`
 * message still arrives afterwards and remains the durable record. Only
 * `text_delta` is lifted:
 *
 * - `input_json_delta` streams a TOOL'S arguments — a large Write's whole file
 *   content would cross the wire twice for no benefit.
 * - `thinking_delta` carries `thinking: ""` — claude redacts reasoning text in
 *   headless mode (probe-verified: the block ships an encrypted `signature`
 *   and an empty body), so there is nothing to show. Reasoning-delta streaming
 *   is also explicitly out of scope for v1.
 * - `message_start` / `message_delta` / `message_stop` / `content_block_*` are
 *   framing the durable events already express.
 *
 * Verified live on claude-opus-5 alongside `--permission-prompt-tool stdio`:
 * deltas and the `can_use_tool` control dialogue coexist on one stream.
 */
export function mapClaudeStreamEvent(
  root: Record<string, unknown>,
): AgentEvent[] {
  const event = asRecord(root.event);
  if (!event || asString(event.type) !== 'content_block_delta') {
    return [];
  }
  const delta = asRecord(event.delta);
  if (!delta || asString(delta.type) !== 'text_delta') {
    return [];
  }
  const text = asString(delta.text);
  return text ? [{ type: 'text_delta', text }] : [];
}

/**
 * Map claude's `system/thinking_tokens` telemetry to a reasoning-progress
 * signal, or [] when the line carries no usable total.
 *
 * The CLI emits this several times per reasoning stretch (observed at 6.6s /
 * 7.6s / 10.9s / 11.3s of one turn) with a running `estimated_tokens` and a
 * per-event delta. It needs no argv flag. This is the ONLY thinking signal a
 * headless consumer gets — the text itself is redacted.
 */
export function mapClaudeThinkingTokens(
  root: Record<string, unknown>,
): AgentEvent[] {
  const tokens = asNumber(root.estimated_tokens);
  return tokens !== null && tokens > 0
    ? [{ type: 'thinking_progress', tokens }]
    : [];
}
