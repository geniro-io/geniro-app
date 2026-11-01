import type { CallBroker } from '../../teams/services/call-broker.service';
import {
  ALWAYS_LOADED_TOOL_META,
  type CallEnvelope,
} from '../../teams/teams.types';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../mcp.types';
import { BaseMcpTool } from './base-mcp-tool';

/**
 * The shared shape of the six CALL tools — `call_agent`, `await_agent`,
 * `answer_agent`, `cancel_agent`, `message_agent` and `list_agent_threads`,
 * the MCP face of the call runtime in `CallBroker`.
 *
 * What they share, and the render family does not: they are offered only to a
 * member with teammates to call, they answer with the broker's envelope
 * (`{status, result?, error?}`) serialized as text — a contract between two
 * AGENTS — and they carry `ALWAYS_LOADED_TOOL_META` so a CLI never defers
 * their schemas.
 */
export abstract class CallMcpTool extends BaseMcpTool {
  protected readonly meta: Record<string, unknown> | null =
    ALWAYS_LOADED_TOOL_META;

  constructor(protected readonly calls: CallBroker) {
    super();
  }

  /** The call surface is offered to a member with teammates to call, and only to one. */
  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.calls.listCallees(runId, memberId).length > 0;
  }

  /** The broker's answer to one call. Never throws. */
  protected abstract envelope(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<CallEnvelope>;

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const envelope = await this.envelope(args, context);
    // Beside the envelope, not one of its arms: every reply the caller reads
    // can tell it the team wrote something new, whatever the call's state.
    const unread = this.calls.unreadTeamNotes(context.runId, context.caller);
    const stage = this.calls.currentStage(context.runId);
    const reply = {
      ...envelope,
      ...(unread > 0 ? { unread_team_notes: unread } : {}),
      ...(stage !== null ? { stage } : {}),
    };
    // A question envelope is a normal outcome, not a tool failure.
    return this.text(JSON.stringify(reply), envelope.status === 'error');
  }

  /**
   * The two call tools that WAIT are run under a signal that trips on either
   * way their reader can go: the socket closing (`gone`), or the client's own
   * `notifications/cancelled` for this request — which cursor-agent sends at
   * its 60s deadline while keeping the POST open, so `gone` alone never trips
   * and the waiter it left would take the next question and hand it to nobody.
   * Either is an ABANDONED wait to the broker: nothing consumed, the call
   * still collectable.
   */
  protected waiting<TOutcome>(
    context: McpCallContext,
    call: (signal: AbortSignal) => Promise<TOutcome>,
  ): Promise<TOutcome> {
    const { gone } = context;
    return context.whileCancellable((cancelled) =>
      call(gone ? AbortSignal.any([gone, cancelled]) : cancelled),
    );
  }
}

/**
 * The refusal for an argument the tool does not read, naming every one it
 * does — the caller has usually lost the schema, so the list is the fix.
 */
export function unknownArgsEnvelope(
  args: Record<string, unknown>,
  accepted: readonly string[],
): CallEnvelope | null {
  const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
  if (unknown.length === 0) {
    return null;
  }
  return invalidArgsEnvelope(
    `unknown argument(s) ${unknown.map((key) => `'${key}'`).join(', ')} — this tool takes only ${accepted.map((key) => `'${key}'`).join(', ')}`,
  );
}

/**
 * Arg validation happens in-envelope — never throw across the transport.
 */
export function invalidArgsEnvelope(message: string): CallEnvelope {
  return { status: 'error', error: `INVALID_ARGS: ${message}` };
}
