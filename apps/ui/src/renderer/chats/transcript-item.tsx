import { memo } from 'react';

import type { ChatItem } from '../../shared/contracts';
import { MessageBubble } from './message-bubble';

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
}: {
  item: ChatItem;
}): React.JSX.Element | null {
  // Workflow-run items carry the node that produced them; tag each row so
  // parallel branches stay readable in the interleaved transcript.
  const tag = (label: string): string =>
    item.nodeId ? `${item.nodeId} · ${label}` : label;
  switch (item.kind) {
    case 'message': {
      const text = payloadString(item.payload, 'text') ?? '';
      const who = item.role === 'user' ? 'user' : 'assistant';
      return (
        <MessageBubble variant={who} role={tag(who)}>
          <div className="whitespace-pre-wrap">{text}</div>
        </MessageBubble>
      );
    }
    case 'reasoning':
      return (
        <MessageBubble variant="reasoning" role={tag('thinking')}>
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
        <MessageBubble variant="error" role={tag('error')}>
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'message') ?? 'unknown error'}
          </div>
        </MessageBubble>
      );
    case 'turn_cancelled':
      return <MessageBubble variant="note">{tag('⊘ cancelled')}</MessageBubble>;
    case 'turn_complete': {
      const usage = (item.payload as { usage?: unknown } | null)?.usage;
      const cost =
        usage && typeof usage === 'object' && 'costUsd' in usage
          ? (usage as { costUsd: unknown }).costUsd
          : null;
      return (
        <MessageBubble variant="note">
          {tag(
            `✓ done${typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}`,
          )}
        </MessageBubble>
      );
    }
    case 'status': {
      const status = payloadString(item.payload, 'status');
      return status ? (
        <MessageBubble variant="note">
          {`${item.nodeId ?? 'run'} → ${status}`}
        </MessageBubble>
      ) : null;
    }
    case 'system': {
      const message = payloadString(item.payload, 'message');
      return message ? (
        <MessageBubble variant="note">{tag(message)}</MessageBubble>
      ) : null;
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
      const callee = payloadString(item.payload, 'calleeNodeId') ?? 'agent';
      const mode = payloadString(item.payload, 'mode') ?? 'sync';
      const callId = payloadString(item.payload, 'callId');
      return (
        <MessageBubble
          variant="call"
          role={tag(
            `📞 call → ${callee}${mode === 'sync' ? '' : ` · ${mode}`}${callId ? ` · ${callId}` : ''}`,
          )}>
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'message') ?? ''}
          </div>
        </MessageBubble>
      );
    }
    case 'call_result': {
      // Payload spreads the call ENVELOPE: status 'ok' carries
      // result.{call_id,agent,text}; 'error' carries the prefixed error line.
      const callee = payloadString(item.payload, 'calleeNodeId') ?? 'agent';
      const callId = payloadString(item.payload, 'callId');
      const suffix = callId ? ` · ${callId}` : '';
      if (payloadString(item.payload, 'status') === 'ok') {
        const result = (item.payload as { result?: unknown } | null)?.result;
        const text =
          result && typeof result === 'object' && 'text' in result
            ? String((result as { text: unknown }).text)
            : pretty(result ?? null);
        return (
          <MessageBubble
            variant="call"
            role={tag(`✓ result ← ${callee}${suffix}`)}>
            <div className="whitespace-pre-wrap">{text}</div>
          </MessageBubble>
        );
      }
      return (
        <MessageBubble
          variant="error"
          role={tag(`✗ call failed ← ${callee}${suffix}`)}>
          <div className="whitespace-pre-wrap">
            {payloadString(item.payload, 'error') ?? 'call failed'}
          </div>
        </MessageBubble>
      );
    }
    case 'await_collected':
      return (
        <MessageBubble variant="note">
          {tag(
            `⏳ collected ${payloadString(item.payload, 'callId') ?? 'call'}`,
          )}
        </MessageBubble>
      );
    case 'call_question': {
      // A call-initiated callee parked on a question — the CALLER (not the
      // user) is expected to answer it via answer_agent.
      const callee = payloadString(item.payload, 'calleeNodeId') ?? 'agent';
      const callId = payloadString(item.payload, 'callId');
      const options = (item.payload as { options?: unknown } | null)?.options;
      const optionLine = Array.isArray(options)
        ? options.filter((o) => typeof o === 'string').join(' / ')
        : '';
      return (
        <MessageBubble
          variant="call"
          role={tag(`❓ question ← ${callee}${callId ? ` · ${callId}` : ''}`)}>
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
      const callee = payloadString(item.payload, 'calleeNodeId') ?? 'agent';
      const callId = payloadString(item.payload, 'callId');
      const suffix = callId ? ` · ${callId}` : '';
      const outcome = payloadString(item.payload, 'outcome');
      if (outcome === 'answered') {
        return (
          <MessageBubble
            variant="call"
            role={tag(`💬 answered → ${callee}${suffix}`)}>
            <div className="whitespace-pre-wrap">
              {payloadString(item.payload, 'answer') ?? ''}
            </div>
          </MessageBubble>
        );
      }
      return (
        <MessageBubble variant="error" role={tag(`✗ question${suffix}`)}>
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
