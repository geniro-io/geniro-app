import { ChevronRight } from 'lucide-react';
import { createContext, memo, useContext, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { type BlockStatus } from './block-shell';
import { RunSettledContext } from './live-row';
import { NestedThreadContext } from './subagent-context';
import { ToolBodyView } from './tool-body-view';
import { ToolCallIcon, ToolOperationIcon } from './tool-icon';
import {
  formatToolName,
  shortenPath,
  toolInputBody,
  toolResultBody,
} from './tool-render';
import {
  showsFileChange,
  toolCallSummary,
  type ToolGroupEntry,
  toolGroupOperations,
  toolGroupSummary,
  type ToolPair,
} from './transcript-groups';
import { payloadString } from './transcript-item';

/**
 * Whether a turn's intermediate steps start FOLDED, whatever the app would
 * otherwise judge worth opening (`Settings.collapseToolSteps`).
 *
 * A context and not a prop: the rows sit several layers below the transcript
 * (turn block → group → row), all of them memoized, and threading a preference
 * through every one of them would re-render each on a change none of them is
 * about. Defaults false, so a row rendered outside a provider — a test, a
 * sub-agent detail panel — behaves exactly as before.
 */
export const CollapseToolStepsContext = createContext(false);

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
  // The user's own press outranks BOTH — the setting decides what a row starts
  // as, never what it can be.
  const collapseSteps = useContext(CollapseToolStepsContext);
  const open = override ?? (!collapseSteps && showsFileChange(pair));
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
 * ONE file change, drawn as part of the conversation rather than as a control.
 *
 * REPORTED against the first cut of the lift-out, which reused {@link ToolRow}:
 * "это не красиво… он не должен коллапсироваться в этом случае. В принципе,
 * вообще не должна быть такая возможность, и оно должно выглядеть ближе к
 * обычному сообщению". Three things follow from that, and they are one idea:
 *
 * - **No fold, and no control to fold with.** The row is here BECAUSE it was
 *   lifted out of its group to be read; a chevron offering to hide it again is
 *   an affordance for undoing the whole point. Not merely open-by-default —
 *   there is no button at all, so there is nothing to press.
 * - **No pill.** `ToolRow`'s bordered, filled header reads as a control, which
 *   is right inside a group of ten of them and wrong for a lone block in the
 *   flow. What is left is a caption: the operation's glyph, the tool's name and
 *   the path.
 * - **The path is said ONCE.** The diff carries its own caption, so the header
 *   and the body were printing the same path a line apart; the body's is
 *   dropped and the header keeps it, where it reads as the block's title.
 *
 * The RESULT is shown only when the change FAILED. For a write that worked it
 * is `File created successfully at: <the path above>` — a second copy of what
 * the header says, in a grey box as tall as the diff — while a failure is the
 * one thing about the change a diff cannot show.
 */
function FileChangeBlock({
  pair,
  settled,
}: {
  pair: ToolPair;
  settled: boolean;
}): React.JSX.Element {
  const payload: unknown = pair.call.payload;
  const name = payloadString(payload, 'name') ?? 'tool';
  const input = (payload as { input?: unknown } | null)?.input;
  const body = toolInputBody(name, input);
  const result = pair.result
    ? ((pair.result.payload as { result?: unknown } | null)?.result ?? null)
    : null;
  const resultBody = toolResultBody(input, result);
  const status = toolPairStatus(pair, settled);
  // Whichever END of the call disclosed the change — claude puts it in the
  // arguments, an ACP agent returns it on the result. `showsFileChange` accepts
  // either, so the block has to render either.
  const change =
    body?.kind === 'diff'
      ? body
      : resultBody.kind === 'diff'
        ? resultBody
        : null;
  // The diff's own caption is the path it is about; `toolCallSummary` is the
  // fallback for the edit that renders as something other than a diff.
  const pathTitle = change?.caption ?? toolCallSummary(pair.call);
  return (
    <div className="flex w-full flex-col gap-1.5 text-sm">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <ToolCallIcon payload={payload} status={status} className="size-3.5" />
        <span
          className={cn(
            'shrink-0 font-mono',
            status === 'error' ? 'font-semibold text-destructive' : undefined,
          )}>
          {formatToolName(name)}
        </span>
        {/* Shortened from the FRONT, like every other path in the transcript:
            CSS truncation eats the filename, which is the half that says what
            changed. The whole thing stays on hover. */}
        <span className="min-w-0 flex-1 truncate font-mono" title={pathTitle}>
          {shortenPath(pathTitle)}
        </span>
      </span>
      {/* INDENTED under the caption, so the diff reads as this block's
          content rather than as a sibling of it — "все еще саб-левел в этом
          сообщении, то есть оно должно быть немного сдвинуто вправо". Losing
          the pill took the last thing that tied the two together, and flush
          left they became two unrelated bands in the flow.

          `pl-6` is the value the grouped row's body already uses, so a change
          sits at the same depth whether it was lifted out or is being read
          inside its group. */}
      <div data-slot="file-change-body" className="flex flex-col gap-1.5 pl-6">
        {change !== null ? (
          <ToolBodyView body={{ ...change, caption: null }} />
        ) : body !== null ? (
          // An edit this app classifies as one but nothing renders as a diff —
          // `MultiEdit`, whose arguments are a list. Its arguments are still
          // worth reading, and `showsFileChange` already refuses a call with no
          // body at all, so this never renders an empty block.
          <ToolBodyView body={body} />
        ) : null}
        {status === 'error' ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-destructive">
              failed
            </span>
            <ToolBodyView body={resultBody} />
          </div>
        ) : null}
      </div>
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
  const collapseSteps = useContext(CollapseToolStepsContext);
  const open =
    override ?? (!collapseSteps && group.pairs.some(showsFileChange));
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
  // ONE file change, lifted out of the run around it — so there is no run left
  // to summarise. A header here would read `Used 1 tool · edited 1 file` over a
  // row already saying `Edit  src/foo.ts`, and put a second chevron in front of
  // a diff the split exists to bring forward.
  if (group.standalone) {
    return (
      <div
        data-role="tool-group"
        data-standalone="true"
        className="flex w-full flex-col gap-1.5 text-sm text-muted-foreground">
        {group.pairs.map((pair) => (
          <FileChangeBlock key={pair.call.id} pair={pair} settled={settled} />
        ))}
      </div>
    );
  }
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
