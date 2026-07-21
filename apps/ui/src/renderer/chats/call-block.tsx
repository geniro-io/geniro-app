import {
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { memo, useState } from 'react';

import { avatarTone, initialsOf } from '../components/ui/avatar';
import { cn } from '../components/ui/utils';
import { MarkdownContent } from './markdown-content';
import { TranscriptEntryView } from './transcript-entry';
import type { CallBlockEntry } from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

/** Block lifecycle in geniro web's vocabulary (StatusBadge). */
type BlockStatus = 'running' | 'done' | 'error' | 'stopped';

function blockStatusOf(status: CallBlockEntry['status']): BlockStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'stopped';
    default:
      return 'running';
  }
}

const STATUS_BADGE_CLASS: Record<BlockStatus, string> = {
  running: 'bg-primary/10 text-primary',
  done: 'bg-success/15 text-success',
  error: 'bg-destructive/10 text-destructive',
  stopped: 'bg-muted text-muted-foreground',
};

function StatusBadge({ status }: { status: BlockStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        STATUS_BADGE_CLASS[status],
      )}>
      {status}
    </span>
  );
}

/** Geniro web's SectionLabel. */
function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="m-0 mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/**
 * Geniro web's InlineText: an accent-tinted text panel clamped to a few
 * lines with a bottom fade and a Show more / Show less toggle.
 */
function InlineClampText({
  text,
  accentClass,
  lines = 3,
}: {
  text: string;
  accentClass: string;
  lines?: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.split('\n').length > lines || text.length > lines * 80;
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2.5 text-[11px] leading-relaxed',
        accentClass,
      )}>
      <div
        className={cn(!expanded && isLong && 'overflow-hidden')}
        style={
          !expanded && isLong
            ? {
                maxHeight: `${lines * 1.8}em`,
                maskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 40%, transparent)',
              }
            : undefined
        }>
        <MarkdownContent content={text} className="text-[11px]" />
      </div>
      {isLong ? (
        <button
          type="button"
          className="mt-1.5 flex items-center gap-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? (
            <>
              <ChevronUp aria-hidden="true" className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown aria-hidden="true" className="size-3" /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/** Geniro web's AgentAvatars pair (caller → callee) for the block header. */
function AvatarPair({
  caller,
  callerKey,
  callee,
  calleeKey,
}: {
  caller: string;
  callerKey: string;
  callee: string;
  calleeKey: string;
}): React.JSX.Element {
  const chip = (name: string, key: string): React.JSX.Element => (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full text-[8px] leading-none font-bold text-primary-foreground',
        avatarTone(key),
      )}>
      {initialsOf(name)}
    </span>
  );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chip(caller, callerKey)}
      <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
      {chip(callee, calleeKey)}
    </span>
  );
}

/**
 * One agent-to-agent call — geniro web's CommunicationBlock, always
 * expanded: an "Agent communication" eyebrow, a neutral card whose header
 * carries the caller→callee avatar pair, the name line, a live spinner and
 * the status chip; the body holds the clamped "Instructions for X" section,
 * the callee's streamed work (each entry in its own sender frame), the
 * clamped "Result from X" (or error) section, and an "N tools" footer.
 */
export const CallBlock = memo(function CallBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: CallBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (nodes?.get(id)?.name ?? id);
  const callee = nameOf(block.calleeNodeId) ?? 'agent';
  const caller = nameOf(block.callerNodeId);
  const status = blockStatusOf(block.status);
  const toolCount = block.entries.reduce(
    (sum, entry) => (entry.type === 'tools' ? sum + entry.pairs.length : sum),
    0,
  );
  const failed = block.status === 'failed';
  return (
    <div data-role="call-block" className="w-full">
      <div className="mb-1.5 ml-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <ArrowRightLeft aria-hidden="true" className="size-3" />
        <span>Agent communication</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
          {caller ? (
            <AvatarPair
              caller={caller}
              callerKey={block.callerNodeId ?? caller}
              callee={callee}
              calleeKey={block.calleeNodeId ?? callee}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {caller ? `${caller} → ${callee}` : callee}
          </span>
          {status === 'running' ? (
            <Loader2
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin text-primary"
            />
          ) : null}
          <StatusBadge status={status} />
        </div>
        <div className="flex flex-col gap-2.5 p-3">
          {block.message ? (
            <div>
              <SectionLabel>Providing instructions for {callee}</SectionLabel>
              <InlineClampText
                text={block.message}
                accentClass="bg-primary/5 border border-primary/20 text-muted-foreground"
              />
            </div>
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
            <div>
              <SectionLabel>Result from {callee}</SectionLabel>
              <InlineClampText
                text={block.result}
                accentClass="bg-success/5 border border-success/40 text-foreground"
              />
            </div>
          ) : null}
          {status === 'running' ? (
            <span className="animate-pulse text-[11px] text-muted-foreground italic">
              {callee} is thinking...
            </span>
          ) : null}
          {toolCount > 0 ? (
            <div className="flex items-center gap-3 pt-0.5 text-[10px] text-muted-foreground">
              <span>
                {toolCount} tool{toolCount === 1 ? '' : 's'}
              </span>
              {failed ? <span>finished with an error</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
