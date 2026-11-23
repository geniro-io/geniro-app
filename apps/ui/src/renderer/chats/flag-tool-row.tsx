import { Flag } from 'lucide-react';
import { useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import type { BlockStatus } from './block-shell';
import { isGeniroFlagToolCall } from './geniro-tool';
import {
  recordOf,
  refusalReason,
  resultTextOf,
  textArg,
  toolCallArgsOf,
} from './tool-result-text';
import { Dot } from './tool-row-parts';
import type { ToolPair } from './transcript-groups';
import { payloadString } from './transcript-payload';

/**
 * TWIN PARSER: the cost and category words of the daemon's `flag_issue` input
 * (`apps/daemon/src/v1/mcp/tools/flag-issue/`).
 */
const FLAG_COSTS = ['work', 'disagreement'] as const;
export type FlagCost = (typeof FLAG_COSTS)[number];

const FLAG_CATEGORIES = [
  'geniro_tool',
  'geniro_instructions',
  'user_instructions',
  'memory',
  'other',
] as const;
export type FlagCategory = (typeof FLAG_CATEGORIES)[number];

const COST_WORDS: Record<FlagCost, string> = {
  work: 'cost work',
  disagreement: 'user disagreed',
};

const CATEGORY_WORDS: Record<FlagCategory, string> = {
  geniro_tool: 'Geniro tool',
  geniro_instructions: 'Geniro instructions',
  user_instructions: 'Your agent instructions',
  memory: 'Memory',
  other: 'Other',
};

/** What a flag call said and got back, read off its untyped payloads. */
export interface FlagToolEntry {
  cost: FlagCost | null;
  category: FlagCategory | null;
  summary: string | null;
  detail: string | null;
  minutesLost: number | null;
  handle: string | null;
  refusal: string | null;
}

/**
 * TWIN PARSER: the result texts of the daemon's `flag_issue` tool
 * (`apps/daemon/src/v1/mcp/tools/flag-issue/`): a recorded flag leads with its
 * handle, a refusal is an error result, and `Not recorded:` is the one refusal
 * without a code.
 */
const RECORDED = /^Flag (F-[0-9a-f]{6}) recorded\./;
const NOT_RECORDED_PREFIX = /^Not recorded: /;

function minutesOf(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 600
    ? value
    : null;
}

function refusalOf(text: string): string {
  return refusalReason(text).replace(NOT_RECORDED_PREFIX, '');
}

/**
 * The flag row a tool pair draws, or null when the pair is not the flag tool of
 * this run's own server. Unlike the other geniro rows it draws a refused call too:
 * a call the daemon refused is exactly the one the user has to see.
 */
export function flagToolEntryOf(pair: ToolPair): FlagToolEntry | null {
  const name = payloadString(pair.call.payload, 'name') ?? '';
  if (!isGeniroFlagToolCall(name, pair.call.runId)) {
    return null;
  }
  const args: Record<string, unknown> = toolCallArgsOf(pair.call.payload) ?? {};
  const resultPayload = recordOf(pair.result?.payload);
  const text = resultTextOf(resultPayload?.result);
  const failed = resultPayload?.isError === true;
  return {
    cost: FLAG_COSTS.find((cost) => cost === args.cost) ?? null,
    category:
      FLAG_CATEGORIES.find((category) => category === args.category) ?? null,
    summary: textArg(args, 'summary'),
    detail: textArg(args, 'detail'),
    minutesLost: minutesOf(args.minutesLost),
    handle: failed ? null : (RECORDED.exec(text ?? '')?.[1] ?? null),
    refusal: failed && text !== null ? refusalOf(text) : null,
  };
}

const LINE_CLASS =
  'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5 text-xs text-muted-foreground';

/**
 * One flag as a single compact line inside the transcript's tool run: what it
 * cost, its category, its summary and the handle it was recorded under. A flag
 * with a detail unfolds it on a press; the press is the only way it opens.
 */
export function FlagToolRow({
  entry,
  status,
}: {
  entry: FlagToolEntry;
  status: BlockStatus;
}): React.JSX.Element {
  const running = status === 'running';
  const refused = status === 'error';
  const [open, setOpen] = useState(false);
  const label = running
    ? 'Flagging a problem'
    : refused
      ? 'Flag not recorded'
      : 'Flagged a problem';
  const line = (
    <>
      <Flag aria-hidden="true" className="size-3.5 shrink-0" />
      <span
        className={cn('font-medium', refused ? 'text-destructive' : undefined)}>
        {label}
      </span>
      {entry.cost === null ? null : (
        <>
          <Dot />
          <span>{COST_WORDS[entry.cost]}</span>
        </>
      )}
      {entry.cost === 'work' && entry.minutesLost !== null ? (
        <>
          <Dot />
          <span>{`~${entry.minutesLost} min`}</span>
        </>
      ) : null}
      {entry.category === null ? null : (
        <>
          <Dot />
          <span>{CATEGORY_WORDS[entry.category]}</span>
        </>
      )}
      {entry.summary === null ? null : (
        <>
          <Dot />
          <span
            className="min-w-0 truncate text-foreground"
            title={entry.summary}>
            {entry.summary}
          </span>
        </>
      )}
      {entry.handle === null ? null : (
        <>
          {' '}
          <span className="font-mono text-primary">{entry.handle}</span>
        </>
      )}
      {refused && entry.refusal !== null ? (
        <>
          <Dot />
          <span className="text-destructive">{entry.refusal}</span>
        </>
      ) : null}
      {running ? <Spinner /> : null}
      {status === 'stopped' ? (
        <>
          <Dot />
          <span className="text-muted-foreground/70">no result</span>
        </>
      ) : null}
    </>
  );
  if (entry.detail === null) {
    return (
      <div data-role="flag-tool" className={LINE_CLASS}>
        {line}
      </div>
    );
  }
  return (
    <div data-role="flag-tool" className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          LINE_CLASS,
          '-mx-1 w-full rounded-md px-1 text-left hover:bg-accent/50 hover:text-foreground',
        )}>
        {line}
      </button>
      {open ? (
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs whitespace-pre-wrap break-words text-foreground">
          {entry.detail}
        </div>
      ) : null}
    </div>
  );
}
