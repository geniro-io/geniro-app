import { SquareTerminal } from 'lucide-react';

import { Spinner } from '../components/ui/spinner';
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
 * One running command: what it is, and how long it has been going.
 *
 * It owns its own clock — see {@link useSecondsTick}. Handed an elapsed number
 * from above, every tick would re-render the whole panel, and the panel holds
 * every agent of the run.
 */
function ShellRow({
  shell,
  onOpen,
}: {
  shell: ShellRun;
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
      <Spinner className="size-3 shrink-0 text-primary" />
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
      {/* Said in a word, not drawn as a second glyph: a detached command is the
          one row that will still be running after the agent has answered, and
          "why is this one still here" needs an answer on the row itself. */}
      {shell.background ? (
        <span className="shrink-0 text-[10px] text-muted-foreground uppercase">
          bg
        </span>
      ) : null}
      {elapsed === null ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      )}
    </li>
  );
}

/**
 * Every shell an agent is running, bounded and scrolling itself.
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
  onOpen,
}: {
  shells: readonly ShellRun[];
  className?: string;
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
          <ShellRow key={shell.id} shell={shell} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}
