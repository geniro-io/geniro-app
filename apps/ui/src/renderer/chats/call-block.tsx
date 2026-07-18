import { Bot, ChevronRight, CornerDownRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../components/ui/utils';
import { MessageBubble } from './message-bubble';
import { RunStatusIcon } from './run-status';
import { ToolGroup } from './tool-group';
import type { CallBlockEntry, TranscriptEntry } from './transcript-groups';
import { TranscriptItem, type TranscriptNodeMeta } from './transcript-item';

/**
 * One agent-to-agent call as a single nested block — the "Caller → Callee"
 * header carries the live sub-turn status (replacing the old separate
 * "call → B" row + "B started" note), and everything the callee streams
 * renders INSIDE, so parallel callees never interleave in the main flow.
 *
 * Geniro-style request → result framing: expanded, the caller's ask opens
 * the block as the REQUEST card and the callee's final answer closes it as
 * the RESULT card (success-tinted); collapsed, the header shows the request
 * one-liner and — once completed — a ↳ result preview line.
 */
export function CallBlock({
  block,
  nodes,
}: {
  block: CallBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  const callee = nameOf(block.calleeNodeId) ?? 'agent';
  const caller = nameOf(block.callerNodeId);
  const renderEntry = (entry: TranscriptEntry): React.ReactNode => {
    if (entry.type === 'call-block') {
      return <CallBlock key={entry.id} block={entry} nodes={nodes} />;
    }
    if (entry.type === 'tools') {
      return <ToolGroup key={entry.id} group={entry} />;
    }
    return (
      <TranscriptItem key={entry.item.id} item={entry.item} nodes={nodes} />
    );
  };
  return (
    <div
      data-role="call-block"
      className="flex w-full flex-col rounded-xl border border-warning/30 bg-warning/10 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <Bot aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
        <RunStatusIcon status={block.status} />
        <span className="shrink-0 font-medium">
          {caller ? `${caller} → ` : ''}
          {callee}
        </span>
        {block.message ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            — {block.message}
          </span>
        ) : null}
      </button>
      {!open && block.result ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-2 pl-[34px] text-xs text-muted-foreground">
          <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{block.result}</span>
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2 border-t border-warning/30 p-2.5">
          {block.message ? (
            <MessageBubble variant="request" role="request">
              <div className="whitespace-pre-wrap">{block.message}</div>
            </MessageBubble>
          ) : null}
          {block.entries.map(renderEntry)}
          {block.result ? (
            <MessageBubble variant="result" role="result">
              <div className="whitespace-pre-wrap">{block.result}</div>
            </MessageBubble>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
