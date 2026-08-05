import { memo } from 'react';

import { InitialsAvatar } from '../components/ui/avatar';
import { CallBlock } from './call-block';
import { liveRowKind } from './live-row';
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
 *
 * In a SINGLE-AGENT chat that frame is dropped entirely (`soloAgent`): with
 * one participant there is nobody to disambiguate, so an avatar and a repeated
 * `claude · 18:43` line under every turn are pure noise. The agent's words then
 * sit bare in the flow, the way a CLI prints them; turn boundaries still read
 * from the `turn_complete` divider between them. The user's own messages keep
 * their bubble either way — the conversation still has two sides.
 */
export const TurnBlock = memo(function TurnBlock({
  block,
  nodes,
  chatAgentName,
  soloAgent = false,
}: {
  block: TurnBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
  /** The run has exactly one agent — drop the identity frame. */
  soloAgent?: boolean;
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
      // A LIVE row (a reasoning stretch, or the agent working silently) owns
      // its own clock and draws itself — it carries no text to flatten here,
      // and rendering it bare would print an empty line. Only DURABLE
      // reasoning text takes the inline path.
      if (liveRowKind(item.payload) !== null) {
        return <TranscriptItem key={item.id} item={item} nodes={nodes} />;
      }
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
  if (soloAgent) {
    return (
      <div
        data-role="turn-block"
        data-solo="true"
        className="flex w-full flex-col gap-2.5 text-sm leading-relaxed">
        {block.entries.map(renderInner)}
      </div>
    );
  }
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
});
