import {
  Activity,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleSlash,
  CircleStop,
  CircleX,
  CornerDownRight,
  Inbox,
  type LucideIcon,
  MessageCircleQuestion,
  Reply,
  RotateCw,
  Send,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { memo, useContext } from 'react';

import { AgentIdentityContext, agentShortName } from '../agent-identity';
import {
  bareThreadIdentity,
  ThreadActionButton,
  ThreadHead,
  type ThreadIdentity,
} from '../components/thread-head';
import {
  type ThreadLabelsView,
  ThreadStatusChip,
} from '../components/thread-labels';
import { AnsiText } from '../components/ui/ansi-text';
import { OptionList } from '../components/ui/option-list';
import { cn } from '../components/ui/utils';
import { formatDuration } from '../stats/stats-format';
import { RevealCallContext } from './call-block';
import { ClampedMarkdown } from './clamped-markdown';
import type { MonitorEnd, MonitorEntry } from './monitor-payload';
import { useThreadFlag } from './thread-ui-memory';
import type { TranscriptNodeMeta } from './transcript-payload';

/** What happened between this thread and another one. */
export type ThreadEventKind = 'sent' | 'received' | 'woken' | 'done';

/** What happened between agents of one run, or with an agent's monitor. */
export type MemberEventKind =
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'asked'
  | 'answered'
  | 'no-answer'
  | 'message'
  | 'answer'
  | 'monitor-reported'
  | 'monitor-stopped'
  | 'monitor-ended';

export type AgentEventKind = ThreadEventKind | MemberEventKind;

export type EventTone =
  'muted' | 'success' | 'destructive' | 'warning' | 'primary';

const ICON_TONE: Record<EventTone, string> = {
  muted: 'text-muted-foreground',
  success: 'text-success',
  destructive: 'text-destructive',
  warning: 'text-warning',
  primary: 'text-primary',
};

const RAIL_TONE: Record<EventTone, string> = {
  muted: 'border-border',
  success: 'border-success/50',
  destructive: 'border-destructive/50',
  warning: 'border-warning/50',
  primary: 'border-primary/40',
};

const KIND_META: Record<
  AgentEventKind,
  { icon: LucideIcon; label: string; tone: EventTone; rail: EventTone }
> = {
  sent: { icon: Send, label: 'Message to', tone: 'muted', rail: 'primary' },
  received: {
    icon: Inbox,
    label: 'Message from',
    tone: 'muted',
    rail: 'muted',
  },
  woken: {
    icon: RotateCw,
    label: 'Woken by a message from',
    tone: 'muted',
    rail: 'muted',
  },
  done: { icon: CircleCheck, label: 'Done', tone: 'success', rail: 'success' },
  finished: {
    icon: CircleCheck,
    label: 'Done',
    tone: 'success',
    rail: 'success',
  },
  failed: {
    icon: CircleX,
    label: 'Failed',
    tone: 'destructive',
    rail: 'destructive',
  },
  cancelled: {
    icon: CircleSlash,
    label: 'Cancelled',
    tone: 'muted',
    rail: 'muted',
  },
  skipped: {
    icon: CircleMinus,
    label: 'Skipped',
    tone: 'muted',
    rail: 'muted',
  },
  asked: {
    icon: MessageCircleQuestion,
    label: 'Question from',
    tone: 'warning',
    rail: 'warning',
  },
  answered: {
    icon: MessageCircleQuestion,
    label: 'Answered question from',
    tone: 'success',
    rail: 'muted',
  },
  'no-answer': {
    icon: Ban,
    label: 'Question from',
    tone: 'destructive',
    rail: 'muted',
  },
  message: { icon: Send, label: 'Message to', tone: 'muted', rail: 'primary' },
  answer: { icon: Reply, label: 'Answer to', tone: 'muted', rail: 'primary' },
  'monitor-reported': {
    icon: Activity,
    label: 'Monitor reported',
    tone: 'muted',
    rail: 'muted',
  },
  'monitor-stopped': {
    icon: CircleStop,
    label: 'Monitor stopped',
    tone: 'muted',
    rail: 'muted',
  },
  'monitor-ended': {
    icon: CircleStop,
    label: 'Monitor ended',
    tone: 'destructive',
    rail: 'muted',
  },
};

type ThreadStatusView = NonNullable<ThreadLabelsView['status']>;

const CALL_STATUS: Partial<Record<MemberEventKind, ThreadStatusView>> = {
  finished: { attention: 'done', text: 'finished' },
  answered: { attention: 'done', text: 'answered' },
  failed: { attention: 'blocked', text: 'failed' },
  asked: { attention: 'question', text: 'asking' },
  'no-answer': { attention: 'blocked', text: 'no answer' },
};

/**
 * The line every event card opens with: what happened, the short name of what
 * it happened in, who it involved, and whether it waits on the reader. Each
 * part's slot is `slot` followed by what it is.
 */
export function EventLine({
  icon,
  tone,
  label,
  slot,
  handle = null,
  member = null,
  waiting = false,
}: {
  icon: LucideIcon;
  tone: EventTone;
  label: string;
  slot: string;
  handle?: string | null;
  member?: string | null;
  waiting?: boolean;
}): React.JSX.Element {
  const Icon = icon;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', ICON_TONE[tone])}
      />
      <span data-slot={`${slot}-label`} className="shrink-0 font-medium">
        {label}
      </span>
      {handle === null ? null : (
        <span
          data-slot={`${slot}-handle`}
          className="shrink-0 rounded-sm bg-muted px-1 font-mono text-foreground/80">
          {handle}
        </span>
      )}
      {member === null ? null : (
        <span data-slot={`${slot}-member`} className="min-w-0 truncate">
          · {member}
        </span>
      )}
      {waiting ? (
        <span
          data-slot={`${slot}-waiting`}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
          <span aria-hidden="true" className="relative flex size-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-warning/60 motion-reduce:animate-none" />
            <span className="relative size-1.5 rounded-full bg-warning" />
          </span>
          Waiting on you
        </span>
      ) : null}
    </p>
  );
}

/** What became of the event, in words, at the card's foot. */
export interface EventOutcome {
  text: string;
  tone?: 'muted' | 'destructive';
}

export interface AgentEventCardProps {
  kind: AgentEventKind;
  /** The prefix of every slot the card draws. */
  slot: string;
  identity?: ThreadIdentity;
  /** Drawn in place of the event line and the head: a card folded to one line. */
  line?: React.ReactNode;
  /** Overrides the kind's own label. */
  label?: string;
  handle?: string | null;
  member?: string | null;
  waiting?: boolean;
  onOpen?: () => void;
  headAside?: React.ReactNode;
  /** Drawn between the head and the text. */
  lead?: React.ReactNode;
  text?: string | null;
  /** Where the text's Show more is remembered within the thread. */
  memoryKey?: string;
  /** Answers a question offered, drawn inert. */
  options?: readonly string[];
  /** Drawn after the text. */
  body?: React.ReactNode;
  actions?: React.ReactNode;
  outcome?: EventOutcome | null;
  data?: Record<`data-${string}`, string | undefined>;
}

/**
 * One event, drawn the way the command center draws a thread: the event line,
 * a head with the face and name of whoever it involved, the text on a rail, its
 * actions and what became of it. Reads no context, so every kind of event —
 * between threads, between agents of a run, from a monitor — shares it.
 */
export function AgentEventCard({
  kind,
  slot,
  identity,
  line,
  label,
  handle = null,
  member = null,
  waiting = false,
  onOpen,
  headAside,
  lead,
  text = null,
  memoryKey,
  options = [],
  body,
  actions,
  outcome = null,
  data,
}: AgentEventCardProps): React.JSX.Element {
  const meta = KIND_META[kind];
  return (
    <article
      data-slot={`${slot}-card`}
      data-kind={kind}
      {...data}
      className={cn(
        'flex w-full min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 text-sm',
        line === undefined ? 'py-2.5' : 'py-1.5',
      )}>
      {line ?? (
        <>
          <EventLine
            icon={meta.icon}
            tone={meta.tone}
            label={label ?? meta.label}
            slot={slot}
            handle={handle}
            member={member}
            waiting={waiting}
          />
          {identity === undefined ? null : (
            <ThreadHead
              identity={identity}
              slot={slot}
              onOpen={onOpen}
              aside={headAside}
            />
          )}
        </>
      )}
      {lead}
      {text === null || text === '' ? null : (
        <div className={cn('border-l-2 pl-3', RAIL_TONE[meta.rail])}>
          <ClampedMarkdown
            text={text}
            lines={8}
            slot={`${slot}-text`}
            className="text-sm text-foreground"
            toggleClassName="text-xs"
            memoryKey={memoryKey}
          />
        </div>
      )}
      {options.length === 0 ? null : (
        <OptionList
          options={options}
          selected={[]}
          arity="one"
          inert
          label="Options"
          onPick={() => undefined}
        />
      )}
      {body}
      {actions === undefined || actions === null ? null : (
        <div className="flex justify-end">{actions}</div>
      )}
      {outcome === null ? null : (
        <p
          data-slot={`${slot}-outcome`}
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-xs',
            outcome.tone === 'destructive'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}>
          <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{outcome.text}</span>
        </p>
      )}
    </article>
  );
}

/** Several events of one row, one under the other. */
export function AgentEventStack({
  children,
  slot = 'agent-event-stack',
}: {
  children: React.ReactNode;
  slot?: string;
}): React.JSX.Element {
  return (
    <div data-slot={slot} className="flex w-full min-w-0 flex-col gap-1.5">
      {children}
    </div>
  );
}

/** A member of the run as its card heads it: its face, its name, its status and its CLI. */
function memberIdentity(
  name: string,
  memberId: string | null,
  meta: TranscriptNodeMeta | undefined,
  agentLabel: string | null,
  status: ThreadStatusView | null,
): ThreadIdentity {
  return {
    ...bareThreadIdentity(name),
    face: {
      kind: 'member',
      name,
      avatar: meta?.avatar ?? null,
      colorKey: memberId ?? name,
    },
    status,
    agentLabel,
  };
}

/** Opens the card of `callId` where one is loaded; nothing where none is. */
function OpenCallButton({
  callId,
}: {
  callId: string | null;
}): React.JSX.Element | null {
  const reveal = useContext(RevealCallContext);
  const open = callId === null ? null : (reveal?.(callId) ?? null);
  if (open === null) {
    return null;
  }
  return (
    <ThreadActionButton
      slot="agent-event-open-call"
      label={`Open ${callId}`}
      title="Show this call in the conversation"
      icon={<SquareArrowOutUpRight aria-hidden="true" />}
      onClick={() => open()}>
      Open call
    </ThreadActionButton>
  );
}

export interface MemberEventCardProps {
  kind: MemberEventKind;
  /** The member's name as the row recorded it. */
  name: string;
  memberId: string | null;
  /** What the run knows of the member, when it is one of its team. */
  meta?: TranscriptNodeMeta;
  callId: string | null;
  /** What the event line says after the label. */
  tail?: string | null;
  text?: string | null;
  options?: readonly string[];
  waiting?: boolean;
  outcome?: EventOutcome | null;
  memoryKey?: string;
}

/**
 * An event between agents of one team run — a call finished, failed or asked
 * something, the lead wrote into a call — headed by the member it is about.
 */
export const MemberEventCard = memo(function MemberEventCard({
  kind,
  name,
  memberId,
  meta,
  callId,
  tail = null,
  text = null,
  options = [],
  waiting = false,
  outcome = null,
  memoryKey,
}: MemberEventCardProps): React.JSX.Element {
  const identities = useContext(AgentIdentityContext);
  const agentLabel =
    meta?.agent === null || meta?.agent === undefined
      ? null
      : agentShortName(identities, meta.agent);
  return (
    <AgentEventCard
      kind={kind}
      slot="agent-event"
      identity={memberIdentity(
        name,
        memberId,
        meta,
        agentLabel,
        CALL_STATUS[kind] ?? null,
      )}
      handle={callId}
      member={tail}
      waiting={waiting}
      text={text}
      options={options}
      outcome={outcome}
      memoryKey={memoryKey}
      actions={<OpenCallButton callId={callId} />}
      data={{
        'data-member': memberId ?? undefined,
        'data-call': callId ?? undefined,
      }}
    />
  );
});

/** How a monitor's command ended, in the words a reader expects. */
export function monitorEndText(end: MonitorEnd): string {
  switch (end.kind) {
    case 'exit':
      return end.code === undefined ? 'exited' : `exit code ${end.code}`;
    case 'signal':
      return end.signal === undefined
        ? 'killed by a signal'
        : `killed by ${end.signal}`;
    case 'timeout':
      return 'timed out';
    case 'stopped':
      return 'stopped';
    case 'flooded':
      return 'flooded';
    case 'interrupted':
      return 'interrupted';
  }
}

/** An ending the reader should not skim past: the command did not finish cleanly. */
function isBadEnd(end: MonitorEnd): boolean {
  return end.kind === 'exit' ? end.code !== 0 : end.kind !== 'stopped';
}

function monitorKindOf(entry: MonitorEntry, woke: boolean): MemberEventKind {
  if (woke || entry.event === 'batch') {
    return 'monitor-reported';
  }
  return entry.end !== null && isBadEnd(entry.end)
    ? 'monitor-ended'
    : 'monitor-stopped';
}

/** Where the monitor stood when this row was written, as its card's status chip says it. */
export function monitorStatusOf(end: MonitorEnd | null): ThreadStatusView {
  if (end === null) {
    return { attention: 'working', text: 'running' };
  }
  switch (end.kind) {
    case 'exit':
      return end.code === 0
        ? { attention: 'done', text: 'finished' }
        : { attention: 'blocked', text: monitorEndText(end) };
    case 'signal':
      return { attention: 'blocked', text: monitorEndText(end) };
    case 'timeout':
    case 'flooded':
    case 'interrupted':
      return { attention: 'question', text: monitorEndText(end) };
    case 'stopped':
      return { attention: 'quiet', text: monitorEndText(end) };
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** What the folded line says after the state: how much it printed. */
export function monitorOutputSize(entry: MonitorEntry): string {
  const count = entry.lines.length + entry.omitted;
  return count === 0 ? 'no output' : plural(count, 'line');
}

function MonitorLine({
  entry,
  kind,
  agent,
  open,
  onToggle,
}: {
  entry: MonitorEntry;
  kind: MemberEventKind;
  agent: string | null;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const status = monitorStatusOf(entry.end);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      data-slot="monitor-event-line"
      aria-expanded={open}
      title={[`${meta.label}: ${entry.description}`, entry.command ?? '']
        .filter((part) => part !== '')
        .join('\n')}
      onClick={onToggle}
      className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-xs leading-5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11">
      <Chevron
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', ICON_TONE[meta.tone])}
      />
      <span
        data-slot="monitor-event-title"
        className="min-w-0 truncate font-medium text-foreground">
        {entry.description}
      </span>
      <ThreadStatusChip
        attention={status.attention}
        slot="monitor-event-status">
        {status.text}
      </ThreadStatusChip>
      <span
        data-slot="monitor-event-handle"
        className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground/80">
        {entry.id}
      </span>
      {agent === null ? null : (
        <span
          data-slot="monitor-event-member"
          className="min-w-0 shrink-[2] truncate text-muted-foreground">
          {agent}
        </span>
      )}
      <span
        data-slot="monitor-event-size"
        className="ml-auto shrink-0 pl-1 text-muted-foreground tabular-nums">
        {monitorOutputSize(entry)}
      </span>
    </button>
  );
}

function MonitorDetails({ entry }: { entry: MonitorEntry }): React.JSX.Element {
  const empty = entry.lines.length + entry.omitted === 0;
  return (
    <div
      data-slot="monitor-event-details"
      className="flex min-w-0 flex-col gap-1.5">
      {entry.command === null && entry.timeoutMs === null ? null : (
        <p
          data-slot="monitor-event-command"
          className="flex min-w-0 items-baseline gap-1.5 text-[11px] leading-4 text-muted-foreground">
          {entry.command === null ? null : (
            <span className="min-w-0 font-mono break-all text-foreground/80">
              <span aria-hidden="true" className="select-none">
                ${' '}
              </span>
              {entry.command}
            </span>
          )}
          {entry.timeoutMs === null ? null : (
            <span
              data-slot="monitor-event-timeout"
              className="ml-auto shrink-0">
              timeout {formatDuration(entry.timeoutMs)}
            </span>
          )}
        </p>
      )}
      {empty ? (
        <p
          data-slot="monitor-no-output"
          className="text-xs text-muted-foreground italic">
          No new output
        </p>
      ) : (
        <pre
          data-slot="monitor-output"
          className="max-h-80 w-full overflow-auto rounded-md border border-border/60 bg-muted/60 px-2.5 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
          <AnsiText text={entry.lines.join('\n')} />
          {entry.omitted > 0 ? (
            <span className="block text-muted-foreground">
              … {entry.omitted} more {entry.omitted === 1 ? 'line' : 'lines'}{' '}
              not delivered
            </span>
          ) : null}
        </pre>
      )}
    </div>
  );
}

/**
 * A monitor's batch that started a turn of the agent's own, or its end, folded
 * to one line — the monitor, where it stands, whose it is and how much it
 * printed — that opens onto its command and output.
 */
export function MonitorEventCard({
  entry,
  woke,
  agent,
  memoryKey,
}: {
  entry: MonitorEntry;
  /** Whether the batch started a turn of the agent's own. */
  woke: boolean;
  /** The agent the monitor reports to. */
  agent: string | null;
  memoryKey: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, false);
  const kind = monitorKindOf(entry, woke);
  return (
    <AgentEventCard
      kind={kind}
      slot="monitor-event"
      line={
        <MonitorLine
          entry={entry}
          kind={kind}
          agent={agent}
          open={open}
          onToggle={() => setOpen((current) => !current)}
        />
      }
      body={open ? <MonitorDetails entry={entry} /> : null}
      data={{ 'data-monitor': entry.id }}
    />
  );
}
