import { memo } from 'react';

import type { ChatItem } from '../../shared/contracts';
import { AlertRow } from './alert-row';
import { MessageBubble } from './message-bubble';

/** What the transcript knows about a workflow node (for display only). */
export interface TranscriptNodeMeta {
  name: string;
  kind: 'agent' | 'trigger';
}

/** Read a string field out of an item's payload, defensively. */
export function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const PRE_CLASS = 'm-0 overflow-x-auto whitespace-pre-wrap font-mono text-xs';

/**
 * One transcript row, rendered by item kind. Memoized: items are immutable
 * (keyed by id), and a streaming workflow run re-renders the whole list per
 * event — without the memo every tool row re-stringifies its payload on each
 * incoming item.
 */
export const TranscriptItem = memo(function TranscriptItem({
  item,
  nodes,
}: {
  item: ChatItem;
  /** Workflow node display metadata, keyed by node id (names + kinds). */
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
}): React.JSX.Element | null {
  const nodeName = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  // Workflow-run items carry the node that produced them; tag each row so
  // parallel branches stay readable in the interleaved transcript.
  const tag = (label: string): string => {
    const name = nodeName(item.nodeId);
    return name ? `${name} · ${label}` : label;
  };
  switch (item.kind) {
    case 'message': {
      // The SenderRow frame (avatar + name + time) identifies the speaker —
      // the bubble carries only the text.
      const text = payloadString(item.payload, 'text') ?? '';
      return (
        <MessageBubble variant={item.role === 'user' ? 'user' : 'assistant'}>
          <div className="whitespace-pre-wrap">{text}</div>
        </MessageBubble>
      );
    }
    case 'reasoning':
      return (
        <MessageBubble variant="reasoning" role="thinking">
          <div className="whitespace-pre-wrap italic">
            {payloadString(item.payload, 'text') ?? ''}
          </div>
        </MessageBubble>
      );
    case 'tool_call':
      return (
        <MessageBubble
          variant="tool"
          role={tag(`🔧 ${payloadString(item.payload, 'name') ?? 'tool'}`)}>
          <pre className={PRE_CLASS}>
            {pretty(
              (item.payload as { input?: unknown } | null)?.input ?? null,
            )}
          </pre>
        </MessageBubble>
      );
    case 'tool_result':
      return (
        <MessageBubble variant="tool" role={tag('⮑ result')}>
          <pre className={PRE_CLASS}>
            {pretty(
              (item.payload as { result?: unknown } | null)?.result ?? null,
            )}
          </pre>
        </MessageBubble>
      );
    case 'error':
      return (
        <AlertRow
          caption="error"
          message={payloadString(item.payload, 'message') ?? 'unknown error'}
        />
      );
    case 'turn_cancelled':
      // A node's cancel already lands as its "<Name> cancelled" status row —
      // only the run-level cancel note remains.
      return item.nodeId !== null ? null : (
        <MessageBubble variant="note">⊘ cancelled</MessageBubble>
      );
    case 'turn_complete': {
      // A node's finished turn already lands as its "<Name> finished" status
      // row (its cost/context live in the agents panel) — only the run-level
      // note renders. That note carries the workflow roll-up in stopReason:
      // a failed/cancelled workflow must not read "✓ done".
      if (item.nodeId !== null) {
        return null;
      }
      const stop = payloadString(item.payload, 'stopReason');
      if (stop === 'workflow_failed') {
        return <MessageBubble variant="note">✗ failed</MessageBubble>;
      }
      if (stop === 'workflow_cancelled') {
        return <MessageBubble variant="note">⊘ cancelled</MessageBubble>;
      }
      const usage = (item.payload as { usage?: unknown } | null)?.usage;
      const cost =
        usage && typeof usage === 'object' && 'costUsd' in usage
          ? (usage as { costUsd: unknown }).costUsd
          : null;
      return (
        <MessageBubble variant="note">
          {`✓ done${typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}`}
        </MessageBubble>
      );
    }
    case 'status': {
      const status = payloadString(item.payload, 'status');
      if (!status) {
        return null;
      }
      // A trigger firing is not news — the user's own message sits right
      // above it. Only agent nodes narrate their lifecycle.
      if (item.nodeId !== null && nodes?.get(item.nodeId)?.kind === 'trigger') {
        return null;
      }
      // A start is not news (the block/tool spinners show liveness), and the
      // "▸" glyph read as a collapse toggle — only settle states narrate.
      if (status === 'running') {
        return null;
      }
      const name = nodeName(item.nodeId) ?? 'run';
      const reason = payloadString(item.payload, 'reason');
      const line =
        status === 'completed'
          ? `✓ ${name} finished`
          : status === 'failed'
            ? `✗ ${name} failed`
            : status === 'cancelled'
              ? `⊘ ${name} cancelled`
              : status === 'skipped'
                ? `− ${name} skipped${reason ? ` — ${reason}` : ''}`
                : `${name} · ${status}`;
      return <MessageBubble variant="note">{line}</MessageBubble>;
    }
    case 'system': {
      const message = payloadString(item.payload, 'message');
      // The daemon's system items are failure advisories (a degraded caller,
      // a persistence problem) — surface them like errors: red, expandable.
      return message ? <AlertRow caption="system" message={message} /> : null;
    }
    case 'approval_verdict': {
      const allow = (item.payload as { allow?: unknown } | null)?.allow;
      const answer = payloadString(item.payload, 'answer');
      return (
        <MessageBubble variant="note">
          {tag(
            allow === true
              ? answer
                ? `✓ answered — ${answer}`
                : '✓ tool approved'
              : '✗ tool denied',
          )}
        </MessageBubble>
      );
    }
    case 'call_started': {
      const callee =
        nodeName(payloadString(item.payload, 'calleeNodeId')) ?? 'agent';
      return (
        <MessageBubble variant="call" role={tag(`📞 call → ${callee}`)}>
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'message') ?? ''}
          </div>
        </MessageBubble>
      );
    }
    case 'call_result': {
      // Payload spreads the call ENVELOPE: status 'ok' carries
      // result.{call_id,agent,text}; 'error' carries the prefixed error line.
      const callee =
        nodeName(payloadString(item.payload, 'calleeNodeId')) ?? 'agent';
      if (payloadString(item.payload, 'status') === 'ok') {
        // A compact receipt only: the result TEXT lives in the call block's
        // RESULT card (or, in legacy flat transcripts, in the callee's own
        // final bubble right above) — repeating it here doubled the payoff.
        return (
          <MessageBubble variant="note">
            {tag(`✓ result from ${callee}`)}
          </MessageBubble>
        );
      }
      return (
        <MessageBubble variant="error" role={tag(`✗ call failed ← ${callee}`)}>
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'error') ?? 'call failed'}
          </div>
        </MessageBubble>
      );
    }
    case 'await_collected':
      // Pure plumbing (the broker's pickup bookkeeping) — the ✓ result
      // receipt right beside it says everything the user needs.
      return null;
    case 'call_question': {
      // A call-initiated callee parked on a question — the CALLER (not the
      // user) is expected to answer it via answer_agent. The SenderRow frame
      // names the asking callee; the bubble keeps only the question marker.
      const options = (item.payload as { options?: unknown } | null)?.options;
      const optionLine = Array.isArray(options)
        ? options.filter((o) => typeof o === 'string').join(' / ')
        : '';
      return (
        <MessageBubble variant="call" role="❓ question">
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'question') ?? ''}
            {optionLine ? (
              <span className="text-muted-foreground">{`\n(${optionLine})`}</span>
            ) : null}
          </div>
        </MessageBubble>
      );
    }
    case 'call_answer': {
      const callee =
        nodeName(payloadString(item.payload, 'calleeNodeId')) ?? 'agent';
      const outcome = payloadString(item.payload, 'outcome');
      if (outcome === 'answered') {
        return (
          <MessageBubble variant="call" role={tag(`💬 answered → ${callee}`)}>
            <div className="whitespace-pre-wrap">
              {payloadString(item.payload, 'answer') ?? ''}
            </div>
          </MessageBubble>
        );
      }
      return (
        <MessageBubble variant="error" role={tag('✗ question')}>
          <div className="whitespace-pre-wrap">
            {outcome === 'timeout'
              ? 'timed out — the caller never answered'
              : outcome === 'undelivered'
                ? 'undelivered — the callee ended before the answer arrived'
                : 'orphaned — the caller ended before answering'}
          </div>
        </MessageBubble>
      );
    }
    default:
      return null; // usage / attachment / approval_request (rendered as a card)
  }
});

/**
 * Approval requests still pending after `verdicts` are applied, judged
 * expired: their node (or the whole run) already hit a terminal state later
 * in the transcript, so no verdict can ever arrive. Returns the payload ids.
 */
export function expiredApprovalIds(
  items: readonly ChatItem[],
  verdicts: ReadonlyMap<string, boolean>,
): Set<string> {
  const expired = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'approval_request') {
      continue;
    }
    const requestId = payloadString(item.payload, 'id');
    if (!requestId || verdicts.has(requestId)) {
      continue;
    }
    const ended = items.some(
      (later) =>
        later.seq > item.seq &&
        ((later.nodeId === item.nodeId &&
          later.kind === 'status' &&
          ['completed', 'failed', 'cancelled', 'skipped'].includes(
            payloadString(later.payload, 'status') ?? '',
          )) ||
          (later.nodeId === null &&
            (later.kind === 'turn_complete' ||
              later.kind === 'turn_cancelled' ||
              later.kind === 'error'))),
    );
    if (ended) {
      expired.add(requestId);
    }
  }
  return expired;
}

/** All persisted verdicts of a transcript, keyed by approval request id. */
export function collectVerdicts(
  items: readonly ChatItem[],
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const item of items) {
    if (item.kind === 'approval_verdict') {
      const id = payloadString(item.payload, 'id');
      if (id) {
        const allow = (item.payload as { allow?: unknown }).allow;
        verdicts.set(id, allow === true);
      }
    }
  }
  return verdicts;
}
