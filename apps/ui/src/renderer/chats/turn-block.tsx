import { InitialsAvatar } from '../components/ui/avatar';
import { CallBlock } from './call-block';
import { MarkdownContent } from './markdown-content';
import { formatClockTime } from './relative-time';
import { ToolGroup } from './tool-group';
import type { TranscriptEntry, TurnBlockEntry } from './transcript-groups';
import {
  payloadString,
  TranscriptItem,
  type TranscriptNodeMeta,
} from './transcript-item';

/**
 * One agent's contiguous run of work as ONE avatar-framed block — the
 * geniro thread story: the agent's starting message, its tool groups and
 * communication cards, and its closing result all live in a single card,
 * with the `sender · time` metadata line under it.
 */
export function TurnBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: TurnBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const name =
    (block.nodeId === null
      ? (chatAgentName ?? null)
      : (nodes?.get(block.nodeId)?.name ?? block.nodeId)) ?? 'agent';
  const renderInner = (entry: TranscriptEntry): React.ReactNode => {
    if (entry.type === 'tools') {
      return <ToolGroup key={entry.id} group={entry} />;
    }
    if (entry.type === 'call-block') {
      return (
        <CallBlock
          key={entry.id}
          block={entry}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      );
    }
    if (entry.type === 'turn-block') {
      return null; // turn blocks never nest — the fold is one level deep
    }
    const item = entry.item;
    // The block IS the bubble: plain markdown text inside, no extra chrome.
    // data-role keeps the transcript's stable test/query hooks per kind.
    if (item.kind === 'message') {
      return (
        <div key={item.id} data-role="assistant">
          <MarkdownContent
            content={payloadString(item.payload, 'text') ?? ''}
          />
        </div>
      );
    }
    if (item.kind === 'reasoning') {
      return (
        <div key={item.id} data-role="reasoning">
          <MarkdownContent
            content={payloadString(item.payload, 'text') ?? ''}
            className="text-muted-foreground italic"
          />
        </div>
      );
    }
    return <TranscriptItem key={item.id} item={item} nodes={nodes} />;
  };
  return (
    <div data-role="turn-block" className="flex w-full gap-3">
      <InitialsAvatar name={name} colorKey={block.nodeId ?? name} />
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <div className="flex w-full flex-col gap-2.5 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
          {block.entries.map(renderInner)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground/60">{name}</span>
          {formatClockTime(block.createdAt) ? (
            <>
              <span>·</span>
              <span>{formatClockTime(block.createdAt)}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
