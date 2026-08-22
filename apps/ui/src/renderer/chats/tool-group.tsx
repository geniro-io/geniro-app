import { ChevronRight } from 'lucide-react';
import { memo, useContext, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { type BlockStatus } from './block-shell';
import { RunSettledContext } from './live-row';
import { NestedThreadContext } from './subagent-context';
import { ToolBodyView } from './tool-body-view';
import { ToolCallIcon, ToolOperationIcon } from './tool-icon';
import { toolOperationOf } from './tool-kind';
import { formatToolName, toolInputBody, toolResultBody } from './tool-render';
import {
  toolCallSummary,
  type ToolGroupEntry,
  toolGroupOperations,
  toolGroupSummary,
  type ToolPair,
} from './transcript-groups';
import { payloadString } from './transcript-item';

/**
 * Where one tool invocation stands.
 *
 * `settled` is "nothing more can arrive for this row" — its own turn ended, or
 * the whole run stopped. It is what separates a call still in flight from one
 * whose result never came, and both are unpaired on the wire, so the row cannot
 * tell them apart on its own.
 */
export function toolPairStatus(pair: ToolPair, settled: boolean): BlockStatus {
  if (pair.result === null) {
    return settled ? 'stopped' : 'running';
  }
  const payload = pair.result.payload as { isError?: unknown } | null;
  return payload?.isError === true ? 'error' : 'done';
}

/**
 * Does this call have a CHANGE TO A FILE to show?
 *
 * REPORTED as "I wanna see all file edits, so it should be automatically open,
 * like claude cli" — the transcript folded every edit behind two presses (the
 * group's chevron, then the row's), so the one part of a turn a reader has to
 * check by eye was the part hidden hardest. Nothing else about the transcript
 * changes: this decides what is OPEN, never what is drawn.
 *
 * Only file changes, and deliberately not "everything". A turn's reads, greps
 * and command output are the material an agent worked FROM; unfolding those
 * too would bury the diff in the wall of text this fold exists to prevent.
 *
 * Asked of BOTH directions, because the two shipped transports report a change
 * at opposite ends of one call: claude discloses it in the arguments
 * (`Edit`'s `old_string`/`new_string`, `Write`'s `content`), while an ACP agent
 * discloses no arguments at all and returns `diffs` on the result. Keying on
 * either alone would open the diffs of one CLI and none of the other's.
 *
 * The last clause is the guard rather than the rule: a tool this classifies as
 * an edit but nothing renders as a diff (`MultiEdit`, whose arguments are a
 * list) still has arguments worth reading, but a row with NO body opens onto
 * blank space and would read as a broken disclosure.
 */
export function showsFileChange(pair: ToolPair): boolean {
  const payload: unknown = pair.call.payload;
  const name = payloadString(payload, 'name') ?? 'tool';
  const input = (payload as { input?: unknown } | null)?.input;
  const body = toolInputBody(name, input);
  if (body?.kind === 'diff') {
    return true;
  }
  if (pair.result !== null) {
    const result =
      (pair.result.payload as { result?: unknown } | null)?.result ?? null;
    if (toolResultBody(input, result).kind === 'diff') {
      return true;
    }
  }
  const operation = toolOperationOf(payload);
  return (operation === 'edit' || operation === 'create') && body !== null;
}

/**
 * One expandable tool invocation inside a group — geniro web's `ToolBlock`
 * shape: a bordered pill carrying a status glyph and the tool's own name in
 * mono, over the input and result it expands into.
 *
 * The one deliberate departure from the reference is the disclosure. Geniro
 * web opens a tool's details in a popover; here the row expands INLINE, which
 * is what lets a diff and a block of command output be read at full width
 * instead of inside a tooltip-sized surface — and the chevron is the affordance
 * that says so.
 */
function ToolRow({
  pair,
  settled,
}: {
  pair: ToolPair;
  settled: boolean;
}): React.JSX.Element {
  // DERIVED from the call, with the user's own press layered over it — never
  // seeded into `useState`, which only reads its argument at mount. A row is
  // mounted the moment the CALL streams in and its diff can arrive later (on
  // the result, for an ACP agent), so a seeded row would stay shut on exactly
  // the edits this exists to show. Same shape as `TaskListCard`'s `latest`.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? showsFileChange(pair);
  // Annotated `unknown` rather than inheriting the generated DTO's `any`: the
  // payload is untyped on the wire BY DESIGN (each item kind carries a different
  // shape), and every reader below is written to narrow it defensively. Without
  // the annotation, handing it to a prop is an unsafe-assignment lint error.
  const payload: unknown = pair.call.payload;
  const name = payloadString(payload, 'name') ?? 'tool';
  const summary = toolCallSummary(pair.call);
  const input = (payload as { input?: unknown } | null)?.input;
  const body = toolInputBody(name, input);
  const result = pair.result
    ? ((pair.result.payload as { result?: unknown } | null)?.result ?? null)
    : null;
  // The CALL's input decides how its result reads (a file's contents have no
  // hint of their own language; command output must not be painted as shell).
  //
  // The RAW result, not its text: a diff the agent reported cannot be recognised
  // once it has been stringified, and pre-stringifying here is exactly why an
  // edit's diff used to render as a wall of escaped JSON.
  const resultBody = toolResultBody(input, result);
  const status = toolPairStatus(pair, settled);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
          status === 'error'
            ? 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10'
            : 'border-border/50 bg-muted/40 hover:bg-muted/70',
        )}>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <ToolCallIcon payload={payload} status={status} className="size-3.5" />
        <span
          className={cn(
            'shrink-0 font-mono',
            status === 'error' ? 'font-semibold text-destructive' : undefined,
          )}>
          {formatToolName(name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summary}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 py-1 pl-6 pr-1.5">
          {body === null ? null : <ToolBodyView body={body} />}
          {pair.result !== null ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                result
              </span>
              <ToolBodyView body={resultBody} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A collapsed run of tool calls — geniro web's WorkingBlock: a bare
 * summary header ("Used N tools · edited M files…", chevron, a spinner
 * while a call is still in flight), with the per-invocation rows behind
 * it; each row expands again to the full input (a red/green diff for
 * Edit/Write) and the tool's result.
 */
export const ToolGroup = memo(function ToolGroup({
  group,
}: {
  group: ToolGroupEntry;
}): React.JSX.Element {
  // Both folds have to give way together, or neither shows anything: opening
  // the edit ROW behind a shut group leaves the diff exactly as invisible as
  // before. So a group holding a file change opens itself, and its other calls
  // — the reads and commands that led to it — come along as the one-line rows
  // they already were, which is what the CLI prints too.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? group.pairs.some(showsFileChange);
  // Only the FACT here, not the moment: a tool call is a single round trip, so
  // "has it spoken since the run stopped" is the same question as "did it
  // return", which `pair.result` already answers. The sub-agent block is where
  // the distinction earns its keep — see {@link RunSettledContext}.
  const runSettled = useContext(RunSettledContext) !== null;
  const nested = useContext(NestedThreadContext);
  // A missing `result` is only evidence of work in flight while the work could
  // still be happening. Two independent things end it, and both are needed:
  // the group's OWN turn ended (`group.closed`), or the whole run has stopped.
  // Neither subsumes the other — the run goes back to `running` on the next
  // message, which is what let a stale group spin again through later turns,
  // while a run cancelled mid-turn ends a group no turn-end item ever closed.
  const settled = group.closed || runSettled;
  const running = !settled && group.pairs.some((pair) => pair.result === null);
  const operations = toolGroupOperations(group.pairs);
  return (
    <div
      data-role="tool-group"
      className="flex w-full flex-col gap-1.5 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="flex items-center gap-1.5 text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        {/*
          Said out loud, because the alternative is what the user reported:
          rows of commands nobody in this conversation asked for, with nothing
          on screen explaining where they came from. The parent tool call's id
          is not shown — it means nothing to a reader — only the fact of the
          delegation.

          Withheld inside a sub-agent enclosure, whose header already names the
          delegate: there, every row of the block would repeat it.
        */}
        {group.parentToolUseId === null || nested ? null : (
          <span className="shrink-0 text-muted-foreground/70">sub-agent</span>
        )}
        {/*
          What the group DID, as glyphs, before the sentence that says the same
          thing in words. The icons existed only once a group was EXPANDED, so
          the one state a reader spends most of their time looking at — a
          transcript of collapsed rows — was a column of identical grey text
          they had to read word by word to scan.

          Drawn from the same fold as the sentence beside them
          (`toolGroupOperations`), so the strip can never name work the words
          do not, and capped at three by that function.
        */}
        {operations.length > 0 ? (
          <span
            data-slot="tool-group-operations"
            className="flex shrink-0 items-center gap-1">
            {operations.map((operation) => (
              <ToolOperationIcon
                key={operation}
                operation={operation}
                className="size-3.5"
              />
            ))}
          </span>
        ) : null}
        <span className="truncate">{toolGroupSummary(group.pairs)}</span>
        {running ? <Spinner /> : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 text-muted-foreground">
          {group.pairs.map((pair) => (
            <ToolRow key={pair.call.id} pair={pair} settled={settled} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
