import { ArrowRight, ArrowRightLeft } from 'lucide-react';
import { memo } from 'react';

import { avatarTone, initialsOf } from '../components/ui/avatar';
import { cn } from '../components/ui/utils';
import {
  BlockPendingLine,
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockTitle,
  BlockToolFooter,
} from './block-shell';
import { TranscriptEntryView } from './transcript-entry';
import { type CallBlockEntry, countTools } from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

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
 *
 * The card chrome itself lives in {@link BlockShell}, shared with the
 * sub-agent block. This block passes no `collapsible`: a call is the point of
 * the row it sits on, so it stays open — unlike a sub-agent aside, which the
 * reader opens deliberately.
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
  const toolCount = countTools(block.entries);
  const failed = block.status === 'failed';
  return (
    <div data-role="call-block" className="w-full">
      <BlockShell
        eyebrow="Agent communication"
        eyebrowIcon={<ArrowRightLeft aria-hidden="true" className="size-3" />}
        status={status}
        header={
          <>
            {caller ? (
              <AvatarPair
                caller={caller}
                callerKey={block.callerNodeId ?? caller}
                callee={callee}
                calleeKey={block.calleeNodeId ?? callee}
              />
            ) : null}
            <BlockTitle>{caller ? `${caller} → ${callee}` : callee}</BlockTitle>
          </>
        }>
        {block.message ? (
          <BlockRequest
            label={`Providing instructions for ${callee}`}
            text={block.message}
          />
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
          <BlockResult label={`Result from ${callee}`} text={block.result} />
        ) : null}
        {status === 'running' ? (
          <BlockPendingLine>{callee} is thinking...</BlockPendingLine>
        ) : null}
        <BlockToolFooter
          count={toolCount}
          note={failed ? <span>finished with an error</span> : undefined}
        />
      </BlockShell>
    </div>
  );
});
