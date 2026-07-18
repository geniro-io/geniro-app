import { ChevronRight, CornerDownRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../components/ui/utils';
import { MessageBubble } from './message-bubble';
import { RunStatusIcon } from './run-status';
import { TranscriptEntryView } from './transcript-entry';
import type { CallBlockEntry } from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

/**
 * One agent-to-agent call as a single nested block. The sender frame around
 * it (avatar, "Caller → Callee" name line, time — see TranscriptEntryView)
 * carries the identity; the block itself holds the live status, the ask,
 * and — expanded — the geniro-style request → result framing: the REQUEST
 * card on top, the callee's streamed work in the middle (each entry in its
 * own sender frame), and the success-tinted RESULT card at the bottom.
 * Collapsed, a ↳ preview line shows the result without expanding.
 */
export function CallBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: CallBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
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
        <RunStatusIcon status={block.status} />
        {block.message ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {block.message}
          </span>
        ) : null}
      </button>
      {!open && block.result ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-2 pl-[26px] text-xs text-muted-foreground">
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
          {block.entries.map((entry) => (
            <TranscriptEntryView
              key={entry.type === 'item' ? entry.item.id : entry.id}
              entry={entry}
              nodes={nodes}
              chatAgentName={chatAgentName}
            />
          ))}
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
