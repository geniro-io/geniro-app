import { Waypoints } from 'lucide-react';
import { memo, useContext } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { formatTokens } from './agent-activity';
import {
  BlockRequest,
  BlockResult,
  BlockShell,
  type BlockStatus,
  BlockStatusIcon,
  SectionLabel,
} from './block-shell';
import { formatElapsed, RunSettledContext, useSecondsTick } from './live-row';
import { workflowCardStatus, type WorkflowEntry } from './transcript-groups';
import {
  type WorkflowAgentRow,
  type WorkflowAgentState,
  workflowTally,
} from './workflow-payload';

/**
 * The card's lifecycle in the block vocabulary — the same translation the
 * sub-agent block makes, so one ending is not spelled two ways on one screen.
 */
function shellStatusOf(
  entry: WorkflowEntry,
  runSettledAt: number | 'unknown' | null,
): BlockStatus {
  switch (workflowCardStatus(entry, runSettledAt)) {
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

/**
 * The MARK beside one agent in the roster — a spinner while it is out, the
 * app's own status glyph once it is not.
 *
 * The colour is the state, on the rule the pull-request lists already follow:
 * a roster is scanned rather than read, and thirty rows each carrying the word
 * `done` is thirty times the ink of the thing the reader is actually looking
 * for, which is the one that failed.
 */
function AgentMark({
  state,
}: {
  state: WorkflowAgentState;
}): React.JSX.Element {
  if (state === 'running') {
    return <Spinner className="size-3 shrink-0" />;
  }
  return (
    <BlockStatusIcon
      status={state === 'failed' ? 'error' : 'done'}
      className="size-3 shrink-0"
    />
  );
}

/** What one agent spent, with a middot between each pair and nowhere else. */
function agentSpendParts(agent: WorkflowAgentRow): string[] {
  return [
    ...(agent.model === null ? [] : [agent.model]),
    ...(agent.tokens === null ? [] : [`${formatTokens(agent.tokens)} tokens`]),
    ...(agent.toolCalls === null || agent.toolCalls === 0
      ? []
      : [`${agent.toolCalls} tool${agent.toolCalls === 1 ? '' : 's'}`]),
    ...(agent.durationMs === null ? [] : [formatElapsed(agent.durationMs)]),
  ];
}

/** One roster row: what this agent is, how it is doing, and what it cost. */
function AgentRow({ agent }: { agent: WorkflowAgentRow }): React.JSX.Element {
  const spend = agentSpendParts(agent);
  return (
    <li
      data-slot="workflow-agent"
      data-state={agent.state}
      className="flex items-baseline gap-2 py-0.5 text-[11px]">
      <span className="flex h-4 shrink-0 items-center">
        <AgentMark state={agent.state} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          agent.state === 'failed' ? 'text-destructive' : 'text-foreground',
        )}>
        {agent.label ?? `agent ${agent.index}`}
      </span>
      {spend.length === 0 ? null : (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {spend.join(' · ')}
        </span>
      )}
    </li>
  );
}

/**
 * The roster, in the workflow's own numbering, captioned wherever the phase
 * changes.
 *
 * Sorted by {@link WorkflowAgentRow.index} rather than left in arrival order:
 * the CLI merges its roster by that key and re-emits it, so the array's order
 * is the order agents were first SEEN, which under `parallel()` is a race.
 */
function AgentRoster({
  agents,
}: {
  agents: readonly WorkflowAgentRow[];
}): React.JSX.Element {
  const ordered = [...agents].sort((a, b) => a.index - b.index);
  const rows: React.JSX.Element[] = [];
  let phase: string | null = null;
  for (const agent of ordered) {
    if (agent.phase !== null && agent.phase !== phase) {
      phase = agent.phase;
      rows.push(
        <li
          key={`phase-${agent.index}`}
          data-slot="workflow-phase"
          className="pt-1.5 first:pt-0 text-[10px] tracking-wide text-muted-foreground uppercase">
          {phase}
        </li>,
      );
    }
    rows.push(<AgentRow key={agent.index} agent={agent} />);
  }
  return <ul className="m-0 list-none p-0">{rows}</ul>;
}

/**
 * A clock that counts real seconds, for a workflow that is still out.
 *
 * Its OWN component so the once-a-second re-render is scoped to a running
 * workflow's header: a settled card renders none of this and re-renders never.
 * Counted from the launching tool call rather than from the CLI's own
 * `duration_ms`, which is a figure on the last roster the workflow sent — a
 * number that freezes between announcements, and the row this replaced had a
 * clock that did not.
 */
function ElapsedSince({ since }: { since: number }): React.JSX.Element {
  useSecondsTick();
  return <>{formatElapsed(Date.now() - since)}</>;
}

/**
 * The headline the card exists for: how many agents ran, and what they spent.
 *
 * Drawn on the HEADER, where it is legible with the card still shut. That is
 * the whole complaint this feature answers — a workflow was `running Workflow ·
 * 20m 34s` and nothing else, for what is routinely the most expensive tool call
 * in a conversation.
 *
 * The running count is named only WHILE some are running: `28 agents` on a
 * finished workflow is the fact; `28 agents · 0 running` is the same fact plus
 * a zero nobody asked for.
 */
function WorkflowFacts({
  entry,
  since,
}: {
  entry: WorkflowEntry;
  /**
   * When the workflow started (ms), while it is STILL RUNNING — null once it
   * is not, which is also what stops the clock below from ticking.
   */
  since: number | null;
}): React.JSX.Element | null {
  const tally = workflowTally(entry.workflow.agents);
  const { tokens, toolUses } = entry.workflow;
  const facts = [
    ...(tally.total === 0
      ? []
      : [`${tally.total} agent${tally.total === 1 ? '' : 's'}`]),
    ...(tally.running === 0 ? [] : [`${tally.running} running`]),
    ...(tally.failed === 0 ? [] : [`${tally.failed} failed`]),
    ...(tokens === null || tokens === 0
      ? []
      : [`${formatTokens(tokens)} tokens`]),
    ...(toolUses === null || toolUses === 0
      ? []
      : [`${toolUses} tool${toolUses === 1 ? '' : 's'}`]),
  ];
  if (facts.length === 0 && since === null) {
    return null;
  }
  return (
    <span
      data-slot="workflow-facts"
      className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
      {facts.join(' · ')}
      {since === null ? null : (
        <>
          {facts.length === 0 ? null : ' · '}
          <ElapsedSince since={since} />
        </>
      )}
    </span>
  );
}

/**
 * One dynamic workflow, drawn as the card that replaces its tool row.
 *
 * Collapsible and closed to start, on the sub-agent block's rule: it is an
 * aside the reader opens deliberately, and the header alone answers the two
 * questions they came with — how many agents, and how much did it cost.
 */
export const WorkflowCard = memo(function WorkflowCard({
  entry,
}: {
  entry: WorkflowEntry;
}): React.JSX.Element {
  const runSettledAt = useContext(RunSettledContext);
  const status = shellStatusOf(entry, runSettledAt);
  const { name, title, activity, agents } = entry.workflow;
  const heading = name ?? title ?? 'Dynamic workflow';
  const launchedAt = Date.parse(entry.createdAt);
  // Non-null only while the workflow is out — which is what scopes the clock's
  // once-a-second re-render to the one card that needs it.
  const since =
    status === 'running' && Number.isFinite(launchedAt) ? launchedAt : null;
  return (
    <div data-slot="workflow-card" data-workflow={entry.id} className="w-full">
      <BlockShell
        eyebrow="Dynamic workflow"
        eyebrowIcon={<Waypoints aria-hidden="true" className="size-3.5" />}
        header={
          <>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {heading}
            </span>
            <WorkflowFacts entry={entry} since={since} />
          </>
        }
        status={status}
        collapsible
        toggleLabel={`Show what the workflow ${heading} ran`}>
        {/* The description, only where it is not already the heading — a script
            with no `meta.name` puts its description on the header itself. */}
        {title !== null && title !== heading ? (
          <p className="m-0 text-[11px] text-muted-foreground">{title}</p>
        ) : null}
        {/* What it is doing RIGHT NOW, and only while it is: the CLI phrases
            this as `Phase: label`, which after the workflow ends is the last
            agent that happened to finish rather than any kind of summary. */}
        {status === 'running' && activity !== null ? (
          <p className="m-0 text-[11px] text-muted-foreground italic">
            {activity}
          </p>
        ) : null}
        {agents === null || agents.length === 0 ? null : (
          <div>
            <SectionLabel>Agents</SectionLabel>
            <AgentRoster agents={agents} />
          </div>
        )}
        {entry.script === null ? null : (
          <BlockRequest
            label="Script"
            // Fenced so it is highlighted rather than reflowed as prose: the
            // panel renders markdown, and a workflow script is JavaScript whose
            // blank lines and indentation are the shape a reader scans.
            text={`\`\`\`js\n${entry.script}\n\`\`\``}
          />
        )}
        {/* Only the workflow's OWN answer — a backgrounded one's call is
            answered with a launch receipt, and framing that as `RESULT` is what
            the sub-agent block already learned not to do. The roster above is
            the report in that case. */}
        {entry.result === null || !entry.resultIsOwn ? null : (
          <BlockResult label="Result" text={entry.result} />
        )}
      </BlockShell>
    </div>
  );
});
