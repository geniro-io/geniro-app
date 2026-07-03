import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from '../../utils/json-util';
import type { AgentEvent, AgentTurnInput, AgentUsage } from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';

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

    case 'control_request': {
      const request = asRecord(root.request);
      const id = asString(root.request_id);
      if (!request || !id || asString(request.subtype) !== 'can_use_tool') {
        return [];
      }
      return [
        {
          type: 'approval_request',
          id,
          toolName: asString(request.tool_name) ?? '',
          input: request.input ?? null,
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
          finalText: asString(root.result) ?? null,
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Drives `claude` headlessly. The prompt is sent as a stream-json user-message
 * line on stdin (`--input-format stream-json`); `--verbose` is required for
 * stream-json output. Resume passes the prior `session_id` via `--resume`.
 *
 * Graph-node extras: `systemPrompt` rides `--append-system-prompt`;
 * `approvalMode: 'ask'` switches on the stdin control protocol
 * (`--permission-prompt-tool stdio` — the CLI pauses each permission-gated
 * tool call as a `control_request` and resumes on our `control_response`),
 * while `'auto'` bypasses permission checks for unattended team execution.
 * Plain chat (no `approvalMode`) keeps the M2 argv byte-for-byte.
 */
export class ClaudeAdapter extends AgentAdapter {
  readonly kind = 'claude' as const;
  protected readonly command = 'claude';

  protected buildArgs(input: AgentTurnInput): string[] {
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
    if (input.systemPrompt) {
      args.push('--append-system-prompt', input.systemPrompt);
    }
    if (input.approvalMode === 'ask') {
      args.push('--permission-mode', 'default');
      args.push('--permission-prompt-tool', 'stdio');
    } else if (input.approvalMode === 'auto') {
      args.push('--dangerously-skip-permissions');
    }
    return args;
  }

  protected override buildStdinPayload(input: AgentTurnInput): string {
    return `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
      },
    })}\n`;
  }

  protected override keepStdinOpen(input: AgentTurnInput): boolean {
    return input.approvalMode === 'ask';
  }

  protected override buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string {
    return `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? { behavior: 'allow', updatedInput: updatedInput ?? {} }
          : { behavior: 'deny', message: 'Denied by the user in Geniro' },
      },
    })}\n`;
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapClaudeMessage(obj);
  }
}
