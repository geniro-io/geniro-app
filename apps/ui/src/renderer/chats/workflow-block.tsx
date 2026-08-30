import { Waypoints } from 'lucide-react';
import { memo, useContext } from 'react';

import { PanelActionRow } from '../components/panel-link-row';
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
import { SHELF_CHIP_CLASS } from './shelf-chip';
import { workflowCardStatus, type WorkflowEntry } from './transcript-groups';
import {
  type WorkflowAgentRow,
  type WorkflowAgentState,
  workflowTally,
} from './workflow-payload';

/**
 * A workflow's lifecycle in the block vocabulary — the same translation the
 * sub-agent block makes, so one ending is not spelled two ways on one screen.
 *
 * Exported because the chip and the panel row draw the same mark from it: a
 * workflow spinning above the composer and reading `completed` in the sidebar
 * is the disagreement this being one function prevents.
 */
export function workflowShellStatus(
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
 * What to CALL a workflow: its script's `meta.name`, else its description, else
 * the category — named once so the card, the chip and the panel row cannot
 * disagree about which workflow the reader is looking at.
 */
export function workflowHeading(entry: WorkflowEntry): string {
  return entry.workflow.name ?? entry.workflow.title ?? 'Dynamic workflow';
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
 * a zero nobody asked for. Exported as parts rather than as a component because
 * the shelf chip and the panel row print the same reading in two other shapes,
 * and three spellings of "how many agents" is how they come to disagree.
 */
export function workflowFactsParts(
  entry: WorkflowEntry,
  {
    /**
     * Say how many are still out. Dropped in the side panel, where the row is
     * a quarter of the width of the transcript's card: the spinner beside the
     * name already says the fleet is working, and a name truncated to `sh…` to
     * make room for `4 running` names nothing at all — which is what the panel
     * did before this option existed.
     *
     * Never dropped for FAILURES below, which have no mark of their own while
     * the workflow is still running and are the one thing a reader is scanning
     * this list for.
     */
    withRunning = true,
  }: { withRunning?: boolean } = {},
): string[] {
  const tally = workflowTally(entry.workflow.agents);
  const { tokens, toolUses } = entry.workflow;
  return [
    ...(tally.total === 0
      ? []
      : [`${tally.total} agent${tally.total === 1 ? '' : 's'}`]),
    ...(tally.running === 0 || !withRunning
      ? []
      : [`${tally.running} running`]),
    ...(tally.failed === 0 ? [] : [`${tally.failed} failed`]),
    ...(tokens === null || tokens === 0
      ? []
      : [`${formatTokens(tokens)} tokens`]),
    ...(toolUses === null || toolUses === 0
      ? []
      : [`${toolUses} tool${toolUses === 1 ? '' : 's'}`]),
  ];
}

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
  const facts = workflowFactsParts(entry);
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
  const status = workflowShellStatus(entry, runSettledAt);
  const { title, activity, agents } = entry.workflow;
  const heading = workflowHeading(entry);
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

/**
 * The mark a compact workflow row leads with — a spinner while the fleet is
 * out, the app's own status glyph once it is not.
 *
 * Shared by the chip and the panel row rather than written twice: they are the
 * same statement about the same workflow, seen from two places on one screen.
 */
function WorkflowMark({ status }: { status: BlockStatus }): React.JSX.Element {
  return status === 'running' ? (
    <Spinner className="size-3.5 shrink-0" />
  ) : (
    <BlockStatusIcon status={status} className="size-3.5 shrink-0" />
  );
}

/**
 * The workflow that is running RIGHT NOW, as a shelf chip above the composer.
 *
 * A press takes the reader to its card in the transcript rather than opening
 * anything here: the card is where the roster, the script and the result
 * already live, and a second surface repeating half of them is how two readings
 * of one workflow come to disagree.
 *
 * The NAME truncates and the figures do not, which is the shelf's own rule —
 * the numbers are what the chip is for, and a `5 agents · 73k tokens` clipped to
 * `5 agen…` says nothing at all.
 */
export function WorkflowChip({
  entry,
  onReveal,
}: {
  entry: WorkflowEntry;
  onReveal: (workflowId: string) => void;
}): React.JSX.Element {
  const runSettledAt = useContext(RunSettledContext);
  const status = workflowShellStatus(entry, runSettledAt);
  const heading = workflowHeading(entry);
  const facts = workflowFactsParts(entry).join(' · ');
  return (
    <button
      type="button"
      data-slot="workflow-chip"
      data-workflow={entry.id}
      title={facts === '' ? heading : `${heading} · ${facts}`}
      aria-label={`Show the workflow ${heading} in the transcript`}
      onClick={() => onReveal(entry.id)}
      className={cn(SHELF_CHIP_CLASS, 'max-w-96')}>
      <WorkflowMark status={status} />
      <span className="min-w-0 truncate font-medium">{heading}</span>
      {facts === '' ? null : (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {facts}
        </span>
      )}
    </button>
  );
}

/**
 * One workflow in the side panel's list — the same statement as the chip, in
 * the shape the panel's other rows take.
 *
 * `PanelActionRow` rather than `PanelLinkRow`: the press goes to a card in this
 * window, and the outward-link glyph is a promise about where a press lands.
 */
export function WorkflowPanelRow({
  entry,
  onReveal,
}: {
  entry: WorkflowEntry;
  onReveal: (workflowId: string) => void;
}): React.JSX.Element {
  const runSettledAt = useContext(RunSettledContext);
  const status = workflowShellStatus(entry, runSettledAt);
  const heading = workflowHeading(entry);
  const facts = workflowFactsParts(entry, { withRunning: false }).join(' · ');
  return (
    <PanelActionRow
      onClick={() => onReveal(entry.id)}
      title={heading}
      tooltip={facts === '' ? heading : `${heading} · ${facts}`}
      icon={<WorkflowMark status={status} />}
      meta={facts === '' ? undefined : facts}
    />
  );
}
