import { Bot, Maximize2 } from 'lucide-react';
import { memo, useContext } from 'react';

import { InitialsAvatar } from '../components/ui/avatar';
import { Button } from '../components/ui/button';
import {
  BlockPendingLine,
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockTitle,
  BlockToolFooter,
  SectionLabel,
} from './block-shell';
import { RunSettledContext } from './live-row';
import { formatClockTime } from './relative-time';
import { NestedThreadContext, SubagentDetailContext } from './subagent-context';
import { TranscriptEntryView } from './transcript-entry';
import {
  countTools,
  type SubagentBlockEntry,
  subagentBlockStatus,
  subagentTitle,
  toolCallSummary,
} from './transcript-groups';
import { payloadString, type TranscriptNodeMeta } from './transcript-item';

function shellStatusOf(
  block: SubagentBlockEntry,
  runSettled: boolean,
): BlockStatus {
  switch (subagentBlockStatus(block, runSettled)) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'stopped';
    default:
      return 'running';
  }
}

/** One step a delegate took, as the timeline lists it. */
interface SubagentStep {
  id: string;
  time: string;
  what: string;
  detail: string | null;
}

/**
 * What the delegate DID, in order — the timeline half of its detail panel.
 *
 * Deliberately a different reading of the same entries the conversation shows,
 * not a second source: the conversation is what it said, this is the sequence
 * of steps it took, which is what a reader scanning a long delegation actually
 * wants. Built by walking the block's own folded entries, so a step can never
 * describe work the thread below does not contain.
 */
export function subagentSteps(block: SubagentBlockEntry): SubagentStep[] {
  const steps: SubagentStep[] = [];
  const walk = (entries: SubagentBlockEntry['entries']): void => {
    for (const entry of entries) {
      if (entry.type === 'tools') {
        for (const pair of entry.pairs) {
          steps.push({
            id: pair.call.id,
            time: formatClockTime(pair.call.createdAt) ?? '',
            what: payloadString(pair.call.payload, 'name') ?? 'tool',
            detail: toolCallSummary(pair.call) || null,
          });
        }
        continue;
      }
      if (entry.type === 'turn-block' || entry.type === 'call-block') {
        walk(entry.entries);
        continue;
      }
      if (entry.type !== 'item') {
        // A sub-agent block never nests inside another — a claude delegate is
        // a leaf and cannot itself delegate.
        continue;
      }
      const item = entry.item;
      if (item.kind === 'message' || item.kind === 'reasoning') {
        const text = payloadString(item.payload, 'text');
        if (text) {
          steps.push({
            id: item.id,
            time: formatClockTime(item.createdAt) ?? '',
            what: item.kind === 'reasoning' ? 'thought' : 'said',
            detail: text.replace(/\s+/g, ' ').slice(0, 120),
          });
        }
        continue;
      }
      if (item.kind === 'error') {
        steps.push({
          id: item.id,
          time: formatClockTime(item.createdAt) ?? '',
          what: 'error',
          detail: payloadString(item.payload, 'message'),
        });
      }
    }
  };
  walk(block.entries);
  return steps;
}

function SubagentTimeline({
  block,
}: {
  block: SubagentBlockEntry;
}): React.JSX.Element {
  const steps = subagentSteps(block);
  if (steps.length === 0) {
    return (
      <p className="m-0 text-[11px] text-muted-foreground">
        This sub-agent has not done anything yet.
      </p>
    );
  }
  return (
    <ol
      data-role="subagent-timeline"
      className="m-0 flex list-none flex-col gap-1 p-0">
      {steps.map((step) => (
        <li key={step.id} className="flex items-baseline gap-2 text-[11px]">
          <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
            {step.time}
          </span>
          <span className="shrink-0 font-medium">{step.what}</span>
          {step.detail ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {step.detail}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * One sub-agent's timeline AND its conversation, for the detail dialog the
 * panel row and the block's own control open.
 */
export function SubagentDetail({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionLabel>Timeline</SectionLabel>
        <SubagentTimeline block={block} />
      </div>
      <div className="flex flex-col gap-2.5 border-t border-border pt-3">
        <SectionLabel>Conversation</SectionLabel>
        <SubagentThread
          block={block}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      </div>
    </div>
  );
}

/**
 * The BODY of a sub-agent block — its request, its thread, its result.
 *
 * Exported because the detail dialog shows exactly this: the whole point of
 * the popup is that the delegate's conversation reads identically wherever it
 * is opened, and two renderings of one thread is how they come to differ.
 */
export function SubagentThread({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const runSettled = useContext(RunSettledContext);
  const title = subagentTitle(block);
  const toolCount = countTools(block.entries);
  const status = subagentBlockStatus(block, runSettled);
  return (
    <NestedThreadContext.Provider value={true}>
      {block.prompt ? (
        <BlockRequest label={`Task for ${title}`} text={block.prompt} />
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
        <BlockResult label={`Result from ${title}`} text={block.result} />
      ) : null}
      {status === 'running' ? (
        <BlockPendingLine>{title} is working...</BlockPendingLine>
      ) : null}
      {status === 'stopped' ? (
        <BlockPendingLine pulse={false}>
          stopped before {title} reported back
        </BlockPendingLine>
      ) : null}
      <BlockToolFooter
        count={toolCount}
        note={status === 'failed' ? <span>returned an error</span> : undefined}
      />
    </NestedThreadContext.Provider>
  );
}

/**
 * One background sub-agent as a collapsed aside in the conversation.
 *
 * Drawn on the same {@link BlockShell} as the agent-call block, and closed by
 * default — which is the difference that matters. A delegate's run of work is
 * not part of the conversation the reader is having; it is a thing that
 * happened underneath it. Open, it shows exactly the thread the detail dialog
 * shows, which is exactly the thread the main flow renders — one
 * {@link TranscriptEntryView} pass, so a delegate's messages, tool groups and
 * reasoning look the way they look anywhere else.
 */
export const SubagentBlock = memo(function SubagentBlock({
  block,
  nodes,
  chatAgentName,
}: {
  block: SubagentBlockEntry;
  nodes?: ReadonlyMap<string, TranscriptNodeMeta>;
  chatAgentName?: string | null;
}): React.JSX.Element {
  const openDetail = useContext(SubagentDetailContext);
  const runSettled = useContext(RunSettledContext);
  const title = subagentTitle(block);
  const toolCount = countTools(block.entries);
  return (
    <div data-role="subagent-block" data-subagent={block.id} className="w-full">
      <BlockShell
        eyebrow="Sub-agent"
        eyebrowIcon={<Bot aria-hidden="true" className="size-3" />}
        status={shellStatusOf(block, runSettled)}
        collapsible
        toggleLabel={`Show ${title}'s conversation`}
        header={
          <>
            <InitialsAvatar name={title} colorKey={block.id} />
            <BlockTitle>{title}</BlockTitle>
            {block.kind && block.label ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {block.kind}
              </span>
            ) : null}
            {toolCount > 0 ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {toolCount} tool{toolCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </>
        }
        // A real <button>, and it sits BESIDE the disclosure rather than
        // inside it: interactive content nested in a <button> is invalid HTML
        // whatever role it carries, and a control there also swallows presses
        // meant for the toggle.
        headerAction={
          openDetail ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground"
              aria-label={`Open ${title} in a panel`}
              title="Open this sub-agent's timeline and conversation"
              onClick={() => openDetail(block)}>
              <Maximize2 className="size-3.5 shrink-0" />
            </Button>
          ) : null
        }>
        <SubagentThread
          block={block}
          nodes={nodes}
          chatAgentName={chatAgentName}
        />
      </BlockShell>
    </div>
  );
});
