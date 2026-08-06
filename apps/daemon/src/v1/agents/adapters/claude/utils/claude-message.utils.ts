import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentEvent,
  AgentMcpServer,
  AgentMcpServerStatus,
  AgentUsage,
} from '../../adapter.types';
import { CLAUDE_RUN_FAILED_MESSAGE } from '../claude.const';
import {
  readClaudeAssistantContext,
  readClaudeUsage,
} from './claude-usage.utils';

/**
 * Whether a `result` line reports NOTHING — no stop reason, no final text, and
 * not one non-zero token or cost figure.
 *
 * The CLI emits such a line at the START of a resumed turn, seconds after the
 * user's message and before any output of that turn (observed on 2.1.222,
 * twice, each time on the turn following one that used `run_in_background`).
 * Taken at face value it is a turn completion, and the damage is threefold:
 * the transcript grows a `✓ done · $0.0000` footer directly under the user's
 * message, the context meter reads the zeros and drops to `0 of 200k`, and —
 * worst — the turn is marked terminated, so the REAL work that follows is
 * never given a completion of its own and its cost never counted.
 *
 * A completion that reports no work is not a completion. Dropping it lets the
 * turn run on, and `ChatService`'s no-terminal-event fallback still writes a
 * terminal item when the process actually settles, so no client is left
 * waiting. The test is deliberately narrow — every genuine completion observed
 * carries `stop_reason: 'end_turn'` plus real token counts — so a legitimate
 * result can never be silently discarded by it.
 */
function describesNoWork(
  usage: AgentUsage,
  stopReason: string | null,
  finalText: string | null,
): boolean {
  if (stopReason !== null || finalText !== null) {
    return false;
  }
  return (
    !usage.inputTokens &&
    !usage.outputTokens &&
    !usage.costUsd &&
    usage.contextTokens === null &&
    usage.contextWindowTokens === null
  );
}

/**
 * The statuses claude's `system/init` reports a loaded MCP server in.
 *
 * `disabled` is one of them — a switched-off server IS still reported, it is
 * simply reported as off. PROBE-VERIFIED on 2.1.223, isolated
 * `CLAUDE_CONFIG_DIR`, one `local`-scope server:
 *
 *   without `disabledMcpServers` → `[{name:'probe-server', status:'failed'}]`
 *   with it                      → `[{name:'probe-server', status:'disabled'}]`
 *
 * matching the 2.1.222 probe recorded at {@link CLAUDE_HOME_DISABLED_MCP_KEY}.
 * The `projects` key is matched on the RESOLVED path, so an entry under
 * `/tmp/...` is not read for a cwd the CLI resolves to `/private/tmp/...` —
 * worth knowing before trusting a re-probe that seems to disagree.
 *
 * Keeping the status here is load-bearing rather than tidy: an unrecognised one
 * degrades to `unknown`, and where the CLI's own config cannot be read the panel
 * falls back to `status === 'disabled'` to decide whether a row is off. A
 * `disabled` row arriving as `unknown` therefore renders as ON.
 *
 * Anything still unrecognised degrades to `unknown` rather than being dropped —
 * the server is real either way, and a status this mapper could not read is not
 * a reason to hide it from the panel.
 */
const INIT_STATUSES: ReadonlySet<string> = new Set<AgentMcpServerStatus>([
  'connected',
  'failed',
  'pending',
  'disabled',
]);

/**
 * The `mcp_servers` rows of a `system/init` line.
 *
 * `target`/`transport`/`detail` are null because init genuinely does not carry
 * them — it reports a name and a state and nothing else (verified live on
 * 2.1.222). Null is the honest answer here for the same reason it is on the
 * `mcp list` path: an empty string would assert a command line the CLI never
 * reported. `AgentMcpService` fills them from a previous listing when it has
 * one.
 */
function readInitMcpServers(root: Record<string, unknown>): AgentMcpServer[] {
  const servers: AgentMcpServer[] = [];
  for (const entry of asArray(root.mcp_servers)) {
    const row = asRecord(entry);
    const name = row ? asString(row.name) : null;
    if (!name) {
      continue;
    }
    const status = row ? asString(row.status) : null;
    servers.push({
      name,
      target: null,
      transport: null,
      status:
        status !== null && INIT_STATUSES.has(status)
          ? (status as AgentMcpServerStatus)
          : 'unknown',
      detail: null,
    });
  }
  return servers;
}

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
        // init's `mcp_servers` names every server this session loaded and the
        // state each was in — harvested so the MCP panel need not re-dial them
        // from cold to answer. Verified live on 2.1.222.
        const servers = readInitMcpServers(root);
        if (servers.length > 0) {
          events.push({ type: 'mcp_servers', servers });
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
      const usage = readClaudeUsage(root);
      const stopReason = asString(root.stop_reason);
      const finalText = asString(root.result) ?? null;
      if (describesNoWork(usage, stopReason, finalText)) {
        return [];
      }
      return [
        {
          type: 'turn_complete',
          usage,
          stopReason,
          finalText,
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
