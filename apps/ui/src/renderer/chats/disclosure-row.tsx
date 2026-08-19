import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronRight, LogIn, TriangleAlert } from 'lucide-react';
import { Fragment, useState } from 'react';

import { CopyButton } from '../components/copy-button';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';

/**
 * A click-expandable transcript row: collapsed it shows a caption and the first
 * line of the message, expanded it shows the full text verbatim (monospace,
 * wrap-preserved).
 *
 * ONE component with three tones rather than three components, because the shape
 * is the same wherever a row carries more text than the transcript should spend
 * on it — and the uses are one behavioural change away from drifting apart
 * (the disclosure wiring, the preview, the expanded body):
 *
 * - `destructive` — something went wrong (`error` items, the daemon's own
 *   `system` advisories). A full-width red panel that claims attention, and the
 *   row may offer the one known cure.
 * - `warning` — something the user CHOSE did not apply, and the turn ran anyway:
 *   a model with no `max` effort, a session mode the agent does not offer. It
 *   needs to be seen (the run is not doing what they asked) and it must not read
 *   as a failure, which is the whole report — a declined effort setting shown in
 *   the red panel above got sent in as "a strange error … and then it carried on
 *   working". Same panel shape as `destructive`, in the palette's amber, which
 *   the call rows already use for "this is a different KIND of thing" rather
 *   than for "this is broken".
 * - `muted` — long text the CLI wrote that geniro is only relaying, the
 *   compaction summary being the case it exists for. It renders as the
 *   transcript's SYSTEM line and nothing more: the same centred, small, quiet
 *   text as `MessageBubble`'s `note` variant — "✓ done · $1.3306" is its
 *   neighbour and its model — with a chevron to say it opens. Quiet because a
 *   summary is not an advisory: dressing relayed prose in the failure chrome told
 *   the user geniro was reporting a problem, and giving it a border, a fill or an
 *   italic of its own made it a THING in the conversation rather than a note in
 *   the margin.
 */
const rowVariants = cva('flex min-w-0 flex-col [&_svg]:shrink-0', {
  variants: {
    tone: {
      destructive:
        'w-full rounded-xl border border-destructive/30 bg-destructive/10 text-sm text-destructive',
      warning:
        'w-full rounded-xl border border-warning/30 bg-warning/10 text-sm text-warning',
      // The `note` variant's own classes, deliberately restated rather than
      // composed: `MessageBubble` cannot host this row (a note is a plain
      // container, and the disclosure needs the button/body split), so the ONE
      // thing that keeps them looking alike is that these read the same.
      muted: 'max-w-full self-center py-1 text-xs text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'destructive' },
});

export type DisclosureTone = NonNullable<
  VariantProps<typeof rowVariants>['tone']
>;

export function DisclosureRow({
  caption,
  message,
  tone = 'destructive',
  detail,
  facts = [],
  copyText,
  onSignIn,
}: {
  /** Row caption, e.g. "flaky · error" or "conversation compacted". */
  caption: string;
  message: string;
  /** Which of the three tones above. Defaults to the failure one. */
  tone?: DisclosureTone;
  /**
   * A short fact about the message, shown INSTEAD of its first line when the row
   * is collapsed — what the compaction did to the context window, say.
   *
   * It replaces the preview rather than joining it because the preview exists to
   * hint at text nobody has read yet; when the row can state what happened, that
   * is the more useful half and a truncated preview beside it only crowds the
   * line.
   */
  detail?: string;
  /**
   * What the failure reported about ITSELF — a code, an HTTP status, the
   * provider's request id (`chats/error-payload.ts` → `errorFactsOf`).
   *
   * Shown INSIDE the expanded body rather than on the collapsed line: the
   * sentence is what a reader recognises the failure by, and a row that led
   * with `404 · req_011Ce…` would push it off a 260px-narrower transcript. The
   * whole reason they are here at all is that a failure used to reach the user
   * as one line of prose with nothing in it anyone could act on or quote.
   */
  facts?: readonly { label: string; value: string }[];
  /**
   * The failure as one block of text, for the clipboard — offered only when a
   * caller has one to give. Copying is the point of the detail rather than a
   * convenience on top of it: what a user does with an error is hand it to
   * somebody, and retyping a request id off a screenshot is where that stops.
   */
  copyText?: string;
  /**
   * Sign the failing CLI back in, when the daemon recognised this failure as a
   * lapsed account session.
   *
   * On the row rather than off in the chrome because this is where the user
   * meets the problem: an expired session rendered as a stack trace, with the
   * fix two screens away, is the gap this closes. Omitted for every failure
   * with no known cure, which is nearly all of them.
   *
   * Named for the ONE recovery that exists rather than taken as a generic
   * `{label, icon, onClick}` action: the row renders a sign-in glyph, so a
   * general seam would let a future non-login cure render under it. Widen this
   * when a second recovery is real, and let its icon arrive with it.
   */
  onSignIn?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = message.split('\n', 1)[0] ?? '';
  const quiet = tone === 'muted';
  return (
    <div
      // The failure tone keeps `error`, which is what the transcript's own specs
      // query for it; the quiet tone is a `system` row and says so, so a test can
      // tell a relayed summary from an advisory without reading its classes. A
      // `warning` gets its own value for the same reason — a degrade that stayed
      // `error` here would be indistinguishable to a test from the failure this
      // tone exists to stop it looking like.
      data-role={quiet ? 'system' : tone === 'warning' ? 'warning' : 'error'}
      className={cn(rowVariants({ tone }))}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide details' : 'Show full details'}
        className={cn(
          'flex w-full items-center gap-1.5 text-left',
          // CENTRED, so opening the row does not move its own header. Expanded,
          // the body takes the full column width and the container grows with it
          // — a left-aligned header then slid from the middle of the transcript
          // to its left edge, and the line the user pressed was no longer under
          // the pointer that pressed it.
          quiet && 'justify-center',
          quiet
            ? // No padding, no fill, no italic — a system line, indistinguishable
              // from the plain notes around it until you point at it. Hover moves
              // the TEXT colour rather than painting a pill behind it: a pill is
              // a control, and this row must read as prose that happens to open.
              //
              // `text-xs font-normal` is NOT redundant with the container's:
              // `global.css` gives every `button` the BASE size and medium weight
              // (15px/500), and an element's own rule beats what it would inherit
              // — so the row rendered a size and a weight above the "✓ done" note
              // it is meant to be indistinguishable from. Measured in the running
              // app: 15px/500 on the button against 11.25px/400 on the note.
              'text-xs font-normal hover:text-foreground'
            : 'px-3 py-2',
        )}>
        {quiet ? null : (
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span
          className={cn(
            'shrink-0',
            // The advisory's caption is a LABEL on a panel; the quiet row's is
            // the sentence itself, and uppercase small-caps beside the plain
            // notes around it read as a different kind of row.
            quiet
              ? null
              : 'text-[11px] font-medium uppercase tracking-wide opacity-70',
          )}>
          {caption}
        </span>
        {detail !== undefined ? (
          <span className={cn('min-w-0', quiet ? null : 'flex-1 text-xs')}>
            {quiet ? `· ${detail}` : detail}
          </span>
        ) : !open ? (
          <span
            className={cn(
              'min-w-0 truncate',
              quiet ? 'max-w-[40ch]' : 'flex-1 text-xs',
            )}>
            {quiet ? `· ${firstLine}` : firstLine}
          </span>
        ) : (
          <span className={cn('min-w-0', quiet ? null : 'flex-1')} />
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            // NOT pushed to the far edge on the quiet row: it belongs beside the
            // words, and expanded — where the row is as wide as the transcript —
            // `ml-auto` would leave it stranded a column away from them.
            open && 'rotate-90',
          )}
        />
      </button>
      {open && facts.length > 0 ? (
        // A definition list, not prose: every row is `label: value`, and the
        // values are ids and numbers that must stay selectable and unwrapped.
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-3 pb-2 font-mono text-xs">
          {facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt className="opacity-70">{fact.label}</dt>
              <dd className="m-0 break-all">{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {open ? (
        // The copy control rides ALONGSIDE the message rather than under it.
        // Given a row of its own it reserved a full band of empty panel below
        // the last line — a lone icon floating in blank fill, which is the
        // reported "strange padding": on a three-line failure the card's bottom
        // third said nothing at all. It stays a SIBLING of the toggle button
        // (a button inside a button is invalid, and the click would fold the
        // row away on its way out) — it has simply stopped needing its own row
        // to be a sibling.
        <div
          className={cn(
            'flex min-w-0 items-start gap-2',
            quiet ? null : 'px-3 pb-2.5',
          )}>
          <pre
            className={cn(
              // `break-words`, not `break-all`: this body carries prose as
              // often as it carries a path, and `break-all` splits at whatever
              // character the line ran out on — the abort sentence wrapped as
              // "interrupted rat / her than refused". `break-words` still
              // breaks a token too long to fit (an id, a URL), which is the
              // only thing `break-all` was here for. The FACTS table keeps it:
              // every value there is an id.
              'm-0 min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs',
              // Expanded, the quiet row has to become readable — centred prose
              // one line wide would be unreadable — so the body takes a surface
              // of its own while the collapsed row keeps none.
              quiet
                ? 'mt-1 max-h-[50vh] overflow-y-auto rounded-lg bg-muted/40 px-3 py-2'
                : null,
            )}>
            {message}
          </pre>
          {copyText !== undefined ? (
            <CopyButton
              text={copyText}
              label="Copy the error report"
              className="shrink-0"
            />
          ) : null}
        </div>
      ) : null}
      {onSignIn ? (
        // A SIBLING of the expand button, never inside it: a button nested in a
        // button is invalid, and the click would toggle the row on its way out.
        // Shown collapsed as well as expanded — the cure is the point of the
        // row, and hiding it behind a disclosure is where it was already.
        <div className="flex px-3 pb-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Open this agent’s CLI sign-in in your terminal, then send the message again"
            onClick={onSignIn}>
            <LogIn aria-hidden="true" className="size-3.5 shrink-0" />
            Sign in
          </Button>
        </div>
      ) : null}
    </div>
  );
}
