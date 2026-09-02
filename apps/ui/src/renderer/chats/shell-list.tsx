import { SquareTerminal } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { formatElapsed, useSecondsTick } from './live-row';
import type { ShellRun } from './shell-activity';

/**
 * The shells an agent has running, rendered — the panel's answer to "what is
 * this thing doing to my machine right now".
 *
 * Every row is LIVE by construction: `runningShellsByAgent` hands over only the
 * shells nothing has settled, and the transcript is where a finished command
 * and its output already live. So there is no settled variant of this list and
 * no fold over one — the section simply disappears when the last command comes
 * back, which is the honest reading of an empty answer.
 */

/**
 * How tall the list may get before it scrolls itself.
 *
 * The same bound, and the same reason, as the task list beside it: the panel
 * has ONE scroller over every agent card, so a fan-out running eight commands
 * at once would not overflow anything — it would make its own card that tall
 * and push the next agent a screen down. 12rem is about six rows.
 */
const PANEL_LIST_MAX_HEIGHT = 'max-h-48';

/** The glyph that marks a shell, wherever one is summarized. */
export function ShellIcon({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <SquareTerminal
      aria-hidden="true"
      className={cn('size-3 shrink-0', className)}
    />
  );
}

/**
 * One running command, on ONE LINE: what it is, whether it outlives the turn,
 * and how long it has been going.
 *
 * The row carries the TERMINAL GLYPH rather than a spinner, and that is what
 * pays for the heading this list no longer has (see {@link ShellRows}): a
 * reader scanning the panel's three bands has to be able to tell commands from
 * tasks without a caption over them, and a monospace string alone does not say
 * it. The spinner it replaced said only "running", which is true of every row
 * here by construction and was therefore the same mark repeated N times — while
 * the clock beside it is already moving, so nothing about liveness is lost.
 *
 * It owns that clock — see {@link useSecondsTick}. Handed an elapsed number
 * from above, every tick would re-render the whole panel, and the panel holds
 * every agent of the run.
 */
function ShellRow({
  shell,
  agentName = null,
  onOpen,
}: {
  shell: ShellRun;
  /**
   * WHOSE command this is, when the list mixes several agents' — a workflow's.
   *
   * Null everywhere the answer is already known: the agents panel draws this
   * band inside one agent's card, and a 1:1 chat has one agent, so naming it on
   * every row would be a column repeating the same word. Only the composer
   * shelf, which flattens every agent's shells into one popover, has a list
   * where the question can be asked at all.
   */
  agentName?: string | null;
  onOpen?: (shell: ShellRun) => void;
}): React.JSX.Element {
  useSecondsTick();
  const started = Date.parse(shell.startedAt);
  // A timestamp that will not parse is not a duration of zero, which is what
  // `NaN` renders as once it reaches `formatElapsed`'s `Math.max(0, …)`: the
  // clock is simply withheld, and the row still says what is running.
  const elapsed = Number.isNaN(started)
    ? null
    : formatElapsed(Date.now() - started);
  return (
    <li
      // Stated on the element because neither is derivable from the outside: a
      // test (and anyone with the inspector open) can otherwise only see the
      // command text, which is the one part that says nothing about the shell's
      // KIND.
      data-slot="shell-row"
      data-shell-background={shell.background}
      className="flex items-center gap-1.5 text-xs">
      {/* Nudged UP by a pixel, and this is an optical correction rather than a
          fudge — REPORTED as "it should be on the same line, now icon a bit
          more down". `items-center` centres BOXES, and a line box is not
          symmetric about its ink: it reserves descender space below the
          baseline that a command like `sleep 400` mostly does not use, so the
          text's visible band sits ABOVE the box centre while a square glyph
          lands exactly on it. Measured off the rendered pixels: the glyph's ink
          centred 3.5 device px below the digits'.

          A pixel rather than the full 3.5, because the two ends of the string
          disagree — `sleep` HAS a descender, so the whole command's ink centres
          only 1 device px above the glyph. Closing the gap to the cap band
          alone would leave the glyph visibly high against the letters. Between
          the two is where it reads as one line.

          Not a line-height change, which was the first thing tried and cannot
          work: shrinking a centred line box moves its top down by exactly half
          of what it takes off the leading, so the ink does not move at all.
          Verified twice, here and on the shelf chip. */}
      <ShellIcon className="-translate-y-px text-muted-foreground" />
      {/* BEFORE the command and `shrink-0`, which is the whole of its layout
          argument: the command is the row's subject and the one part worth the
          flex space, while the name identifies the row and must not truncate to
          nothing — an agent called `Engineer` clipped to `Eng…` answers the
          question worse than not asking it. It is set in the muted colour the
          clock beside it uses rather than as a `Badge`: a badge on every row of
          a dozen is a second column of chrome, and this is a caption on the
          command, not a status about it. */}
      {agentName === null ? null : (
        <span
          data-slot="shell-agent"
          className="shrink-0 text-[11px] text-muted-foreground"
          title={`Started by ${agentName}`}>
          {agentName}
        </span>
      )}
      {onOpen === undefined ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          // The whole command, and the note the agent wrote about it. The
          // column is 280px and these are routinely a pipeline; truncation is
          // what keeps the row one line, and this is what makes the rest
          // reachable.
          title={
            shell.description === null
              ? shell.command
              : `${shell.command}\n\n${shell.description}`
          }>
          {shell.command}
        </span>
      ) : (
        <button
          type="button"
          // `font-normal text-[11px]` is an OVERRIDE, not decoration:
          // `styles/global.css` gives every bare `button` the base 15px at
          // medium weight, so without it this row would render half again the
          // size of the `bg` and clock beside it — the same correction the
          // panel's sub-agent rows carry.
          className="min-w-0 flex-1 truncate rounded text-left font-mono text-[11px] font-normal transition-colors hover:text-foreground hover:underline"
          title={`Show what this command has printed — ${shell.command}`}
          onClick={() => onOpen(shell)}>
          {shell.command}
        </button>
      )}
      {/* Said in a WORD, not an abbreviation and not a second glyph: a detached
          command is the one row that will still be running after the agent has
          answered, and "why is this one still here" needs an answer on the row
          itself. It read `BG` until it was REPORTED as unreadable ("not
          understandable what is BG") — two letters of shell jargon, set in the
          same muted grey as the clock beside them, so the one row carrying an
          explanation was the one nobody could decode. It is drawn as a TAG
          rather than as more muted text for the same reason: a bare word
          between a command and a duration reads as part of one of them. The
          sentence a tag has no room for lives on `title`. */}
      {shell.background ? (
        <span
          className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
          title="Detached — this command keeps running after the agent's turn ends">
          background
        </span>
      ) : null}
      {/* A COLUMN, not a trailing word: the clock is the last thing on the row
          and its width swings with the duration (`7s` against `2m 29s`), so
          left to size itself it pushes everything before it sideways — two
          rows of one list then carry their `background` tags at two different
          x positions, which reads as a broken layout rather than as two
          durations. `min-w` and not a fixed width, since nothing here bounds
          how long a detached command runs. */}
      {elapsed === null ? null : (
        <span className="min-w-[3.25rem] shrink-0 text-right tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      )}
    </li>
  );
}

/**
 * Every shell an agent is running, bounded and scrolling itself.
 *
 * There is NO heading over these rows, and that is the fix for the reported
 * "not in one line". The panel's band used to caption them `1 shell running`,
 * so the commonest case — one command — spent two lines saying one thing, the
 * second of them a count of the single row beneath it. Nothing was lost by
 * cutting it: with the finished commands deliberately absent there was never a
 * `done/total` to state, and every row now says on its own line what the
 * caption used to say about all of them together.
 *
 * The empty case is a SENTENCE rather than an empty box, on the same rule the
 * header's sub-agent list follows: the counter beside it is drawn at zero, and
 * a popover with nothing in it reads as a readout that failed to load. The
 * panel's own section never reaches this — it draws nothing at all when there
 * is nothing running, because there the heading would be the empty box.
 */
export function ShellRows({
  shells,
  className,
  agentNameOf,
  onOpen,
}: {
  shells: readonly ShellRun[];
  className?: string;
  /**
   * Which agent each command belongs to, keyed by shell id — see
   * {@link ShellRow}'s `agentName`. Absent leaves every row unlabelled, which
   * is right for a list that is already about one agent.
   */
  agentNameOf?: ReadonlyMap<string, string>;
  /**
   * Open one command's own output. Absent leaves the rows as plain text — the
   * list never invents a surface it was not given, the same rule the panel's
   * sub-agent rows follow.
   */
  onOpen?: (shell: ShellRun) => void;
}): React.JSX.Element {
  if (shells.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Nothing running — this thread&rsquo;s agents have no shell open.
      </p>
    );
  }
  return (
    <div
      data-slot="shell-rows"
      className={cn(
        'overflow-y-auto overscroll-contain',
        PANEL_LIST_MAX_HEIGHT,
      )}>
      <ul className={cn('m-0 flex list-none flex-col gap-1 p-0', className)}>
        {shells.map((shell) => (
          <ShellRow
            key={shell.id}
            shell={shell}
            agentName={agentNameOf?.get(shell.id) ?? null}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
}
