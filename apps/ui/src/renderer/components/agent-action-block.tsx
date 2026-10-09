import { Check, Clock3, MessageSquare, OctagonX, X } from 'lucide-react';

import type { BlockStatus } from '../chats/block-shell';
import { ToolBodyView } from '../chats/tool-body-view';
import {
  toolInputBody,
  toolResultBody,
  toolResultText,
} from '../chats/tool-render';
import type { ToolPair } from '../chats/transcript-groups';
import {
  payloadString,
  type TranscriptNodeMeta,
} from '../chats/transcript-payload';
import { Spinner } from './ui/spinner';
import { cn } from './ui/utils';

type AgentAction = 'message' | 'cancel';

/** Only Geniro's own actions; another MCP server can use the same tool names. */
export function agentActionOf(pair: ToolPair): AgentAction | null {
  const name = payloadString(pair.call.payload, 'name') ?? '';
  const server = `geniro-${pair.call.runId.slice(0, 8)}`;
  for (const action of ['message', 'cancel'] as const) {
    const tool = `${action}_agent`;
    if (
      name === `mcp__geniro__${tool}` ||
      name === `mcp__${server}__${tool}` ||
      name.toLowerCase() === `${server}: ${tool}` ||
      name.toLowerCase() === `${server}: ${tool.replace('_', ' ')}`
    ) {
      return action;
    }
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return recordOf(parsed);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The broker envelope may arrive directly, as text, or in MCP content blocks. */
function envelopeOf(result: unknown): Record<string, unknown> | null {
  const record = recordOf(result);
  if (record !== null && typeof record.status === 'string') {
    return record;
  }
  return recordOf(toolResultText(record?.content ?? result));
}

export function AgentActionBlock({
  pair,
  action,
  status,
  nodes,
}: {
  pair: ToolPair;
  action: AgentAction;
  status: BlockStatus;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
}): React.JSX.Element {
  const payload: unknown = pair.call.payload;
  const name = payloadString(payload, 'name') ?? '';
  const input: unknown = (payload as { input?: unknown } | null)?.input;
  const args = recordOf(input);
  const result: unknown = (
    pair.result?.payload as {
      result?: unknown;
    } | null
  )?.result;
  const envelope = envelopeOf(result);
  const receipt = recordOf(envelope?.result);
  const agentId = payloadString(receipt, 'agent');
  const recipient =
    (agentId === null ? null : (nodes?.get(agentId)?.name ?? agentId)) ??
    payloadString(args, 'agent') ??
    'agent';
  const state = payloadString(receipt, 'state');
  const failed = status === 'error' || envelope?.status === 'error';
  const message = payloadString(
    args,
    action === 'message' ? 'message' : 'reason',
  );
  const label = failed
    ? action === 'message'
      ? 'Not sent'
      : 'Failed'
    : status === 'running'
      ? action === 'message'
        ? 'Sending'
        : 'Requesting stop'
      : status === 'stopped'
        ? 'Not completed'
        : state === 'delivered'
          ? 'Delivered'
          : state === 'queued'
            ? 'Queued'
            : state === 'cancelling'
              ? 'Stopping'
              : state === 'cancelled_before_it_started'
                ? 'Cancelled before starting'
                : state === 'already_finished'
                  ? 'Already finished'
                  : 'Completed';
  const Icon = action === 'message' ? MessageSquare : OctagonX;
  const StatusIcon =
    failed || status === 'stopped' ? X : state === 'queued' ? Clock3 : Check;
  const inputBody = toolInputBody(name, input);

  return (
    <div
      data-role="agent-action"
      data-action={action}
      className="flex min-w-0 gap-3 py-1 text-sm">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          failed
            ? 'bg-destructive/10 text-destructive'
            : 'bg-primary/10 text-primary',
        )}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span className="min-w-0 break-words font-medium text-foreground">
            {action === 'message' ? 'Message to' : 'Stop request for'}{' '}
            {recipient}
          </span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-[11px]',
              failed ? 'text-destructive' : 'text-muted-foreground',
            )}>
            {status === 'running' && !failed ? (
              <Spinner />
            ) : (
              <StatusIcon aria-hidden="true" className="size-3" />
            )}
            {label}
          </span>
        </div>
        {message !== null ? (
          <div
            className={cn(
              'whitespace-pre-wrap break-words rounded-r-lg border-l-2 px-3.5 py-2.5 leading-relaxed [overflow-wrap:anywhere]',
              failed
                ? 'border-destructive/40 bg-destructive/5'
                : 'border-primary/40 bg-primary/5',
            )}>
            {message}
          </div>
        ) : null}
        {failed ? (
          <p className="whitespace-pre-wrap break-words text-xs text-destructive [overflow-wrap:anywhere]">
            {payloadString(envelope, 'error') ??
              (result == null
                ? 'The action could not be completed.'
                : toolResultText(result))}
          </p>
        ) : null}
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none transition-colors hover:text-foreground">
            Details
          </summary>
          <div className="mt-2 flex min-w-0 flex-col gap-2">
            {inputBody === null ? null : <ToolBodyView body={inputBody} />}
            {pair.result === null ? null : (
              <ToolBodyView body={toolResultBody(input, result)} />
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
