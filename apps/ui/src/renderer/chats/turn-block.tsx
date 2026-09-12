import { memo, useContext } from 'react';

import { InitialsAvatar } from '../components/ui/avatar';
import { cn } from '../components/ui/utils';
import { CallBlock } from './call-block';
import { EntryCard } from './entry-card';
import { liveRowKind } from './live-row';
import { MarkdownContent } from './markdown-content';
import { formatClockTime } from './relative-time';
import { SubagentBlock } from './subagent-block';
import { NestedThreadContext } from './subagent-context';
import { ThinkingDisclosure } from './thinking-block';
import { ToolGroup } from './tool-group';
import {
  isCardEntry,
  type TranscriptEntry,
  type TurnBlockEntry,
} from './transcript-groups';
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
  const nested = useContext(NestedThreadContext);
  const name =
    (block.nodeId === null
      ? (chatAgentName ?? null)
      : (nodes?.get(block.nodeId)?.name ?? block.nodeId)) ?? 'agent';
  /**
   * A delegate's work, said out loud on the BLOCK.
   *
   * It has to be here rather than on the rows: `renderInner` draws a message
   * itself, so `TranscriptItem`'s own `sub-agent` caption is never reached for
   * anything inside a block — and every assistant message is inside one. The
   * whole block is one thread (the fold splits on exactly this), so one label
   * says it once instead of repeating on every row.
   *
   * Withheld inside a sub-agent ENCLOSURE, which names the delegate in its own
   * header: there the caption is the same fact stated twice, one line apart.
   */
  const subagentLabel =
    block.subagentId === null || nested ? null : (
      <span
        data-role="subagent-label"
        className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase opacity-70">
        sub-agent
      </span>
    );
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
    if (entry.type === 'subagent-block') {
      return (
        <SubagentBlock
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
    if (isCardEntry(entry)) {
      return <EntryCard key={entry.id} entry={entry} />;
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
      // The SAME fold the standalone bubble uses — one disclosure shared, two
      // bodies, because a turn block renders reasoning as markdown and the
      // bubble prints it verbatim. Sharing the body instead would make one of
      // them change how it draws prose.
      const reasoning = payloadString(item.payload, 'text') ?? '';
      return (
        <div key={item.id} data-role="reasoning">
          <ThinkingDisclosure text={reasoning}>
            <MarkdownContent
              content={reasoning}
              className="text-muted-foreground italic"
            />
          </ThinkingDisclosure>
        </div>
      );
    }
    return <TranscriptItem key={item.id} item={item} nodes={nodes} />;
  };
  // `nested` joins `soloAgent` here, and for a sharper reason than noise: inside
  // a sub-agent enclosure the frame does not merely repeat an identity, it
  // asserts the WRONG one. The avatar and the `claude · 15:28` line under it are
  // drawn from `block.nodeId`, which every delegate row carries as the
  // DELEGATING agent's — so a delegate's tool run was captioned as the chat
  // agent's own work, one line under a header naming the delegate.
  if (soloAgent || nested) {
    return (
      <div
        data-role="turn-block"
        data-solo="true"
        data-subagent={block.subagentId ?? undefined}
        className={cn(
          'flex w-full flex-col gap-2.5 text-sm leading-relaxed',
          // Set in from the main thread it was delegated from — the label
          // names it, the rule makes the run of rows read as one aside at a
          // glance rather than as the conversation continuing.
          //
          // Not inside an enclosure: there the CARD is that separation already,
          // and a second rule indents the delegate's rows within their own box.
          !nested &&
            block.subagentId !== null &&
            'border-l-2 border-border pl-3',
        )}>
        {subagentLabel}
        {block.entries.map(renderInner)}
      </div>
    );
  }
  // The block is TITLED, on the eyebrow the transcript's other agent cards
  // already wear (`MANAGER · ANSWERED → ENGINEER`, `Question for Manager`). It
  // carried its name only as a small `Engineer · 22:42` line UNDER the card, so
  // a block sandwiched between two titled cards read as an untitled box —
  // REPORTED as "strange design for engineer block without any title", on the
  // Engineer carrying on after its Manager answered — and on a long block the
  // name arrived a screen after the words it identified.
  const time = formatClockTime(block.createdAt);
  return (
    <div
      data-role="turn-block"
      data-subagent={block.subagentId ?? undefined}
      className="flex w-full gap-3">
      <InitialsAvatar name={name} colorKey={block.nodeId ?? name} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
        <div
          data-slot="turn-block-header"
          className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
          <span className="min-w-0 truncate text-foreground/80">{name}</span>
          {subagentLabel === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              {subagentLabel}
            </>
          )}
          {time ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="normal-case tabular-nums">{time}</span>
            </>
          ) : null}
        </div>
        {block.entries.map(renderInner)}
      </div>
    </div>
  );
});
