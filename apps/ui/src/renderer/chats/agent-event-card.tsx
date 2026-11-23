import {
  Activity,
  Ban,
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
import type { ThreadLabelsView } from '../components/thread-labels';
import { AnsiText } from '../components/ui/ansi-text';
import { Button } from '../components/ui/button';
import { OptionList } from '../components/ui/option-list';
import { cn } from '../components/ui/utils';
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
  identity: ThreadIdentity;
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
      className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-sm">
      <EventLine
        icon={meta.icon}
        tone={meta.tone}
        label={label ?? meta.label}
        slot={slot}
        handle={handle}
        member={member}
        waiting={waiting}
      />
      <ThreadHead
        identity={identity}
        slot={slot}
        onOpen={onOpen}
        aside={headAside}
      />
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
    meta?.agent == null ? null : agentShortName(identities, meta.agent);
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

function MonitorOutput({
  entry,
  memoryKey,
}: {
  entry: MonitorEntry;
  memoryKey: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, false);
  return (
    <div className="flex w-full flex-col gap-1">
      <Button
        type="button"
        variant="link"
        className="h-auto self-start p-0 text-xs max-sm:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        Output
      </Button>
      {open ? (
        <pre
          data-slot="monitor-output"
          className="max-h-60 w-full overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground">
          <AnsiText text={entry.lines.join('\n')} />
          {entry.omitted > 0 ? (
            <span className="block text-muted-foreground">
              … {entry.omitted} more {entry.omitted === 1 ? 'line' : 'lines'}{' '}
              not delivered
            </span>
          ) : null}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * A monitor's batch that started a turn of the agent's own, or its end: headed
 * by the monitor, the delivered output folded under it.
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
  const kind = monitorKindOf(entry, woke);
  const end = entry.end;
  return (
    <AgentEventCard
      kind={kind}
      slot="monitor-event"
      identity={{
        ...bareThreadIdentity(entry.description),
        face: { kind: 'monitor' },
      }}
      handle={entry.id}
      member={agent}
      body={
        entry.lines.length + entry.omitted > 0 ? (
          <MonitorOutput entry={entry} memoryKey={memoryKey} />
        ) : null
      }
      outcome={
        end === null || (kind === 'monitor-stopped' && end.kind === 'stopped')
          ? null
          : {
              text: monitorEndText(end),
              tone: isBadEnd(end) ? 'destructive' : 'muted',
            }
      }
      data={{ 'data-monitor': entry.id }}
    />
  );
}
