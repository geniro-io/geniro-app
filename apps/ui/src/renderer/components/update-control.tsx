import { ArrowDownToLine, RotateCw, TriangleAlert } from 'lucide-react';

import type { FooterUpdate } from '../updates/update-status';
import { cn } from './ui/utils';

/**
 * The app's ONE update affordance, wherever it is drawn.
 *
 * Extracted from the nav rail's footer when the shell grew a real title bar and
 * the offer moved up into it. A component rather than a second copy of the
 * markup for the reason `.claude/rules/renderer-components.md` gives: two
 * renderings of one state are two things that can disagree about it, and this
 * one has six — an offer, a readout, a download, a swap, a restart and a failed
 * install — which is exactly the kind of switch that drifts when duplicated.
 *
 * Deliberately NOT a filled button. A primary pill in the title bar is the
 * loudest thing in the shell, for an offer that is not urgent and has no
 * deadline — so it is a text affordance at the row's own size, carrying a glyph
 * and a version and nothing else. The sentence lives in `title` and in Settings;
 * this is a hint, not a paragraph.
 */
export function UpdateControl({
  update,
  onInstall,
  onRelaunch,
}: {
  /**
   * What to offer, already resolved by the caller.
   *
   * A projection of main's one `UpdateState` (`footerUpdate`), not the state
   * itself: this RENDERS the offer, it does not decide there is one — the same
   * split Settings follows, so the two surfaces cannot disagree about whether
   * an update exists.
   */
  update: FooterUpdate;
  /** Start the download for an `install`, or try again after an `error`. */
  onInstall?: () => void;
  /** Restart into a bundle that has finished installing (`restart`). */
  onRelaunch?: () => void;
}): React.JSX.Element | null {
  if (update.kind === 'none') {
    return null;
  }

  const shared =
    'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium';

  if (update.kind === 'readout') {
    // Deliberately NOT a button. This offer is real but THIS install cannot
    // apply it (a Homebrew install, a translocated copy), and the shell's own
    // rule is "no dead affordance" — a control that cannot work is worse than
    // none. `title` carries the command that does.
    return (
      <span
        data-slot="update-readout"
        aria-label={update.title}
        title={update.title}
        className={cn('app-no-drag', shared, 'text-muted-foreground')}>
        <ArrowDownToLine aria-hidden="true" className="size-3 shrink-0" />
        <span>{update.label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      data-slot="update-control"
      aria-label={update.title}
      title={update.title}
      // `progress` is a state, not a control: the download is already running
      // and there is nothing a press could add.
      disabled={update.kind === 'progress'}
      onClick={update.kind === 'restart' ? onRelaunch : onInstall}
      className={cn(
        // A control inside a drag region never receives the click — the
        // compositor takes the press for the window — so this is not optional
        // decoration, it is what makes the button pressable at all.
        'app-no-drag outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
        shared,
        update.kind === 'progress'
          ? 'text-muted-foreground'
          : 'hover:bg-sidebar-accent',
        update.kind === 'error'
          ? 'text-destructive'
          : update.kind === 'progress'
            ? ''
            : 'text-sidebar-primary-strong',
      )}>
      {update.kind === 'restart' ? (
        <RotateCw aria-hidden="true" className="size-3 shrink-0" />
      ) : update.kind === 'error' ? (
        <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <ArrowDownToLine
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0',
            // Only while something is actually moving. A standing offer that
            // pulses is the pill's loudness back in another form.
            update.kind === 'progress' && 'animate-pulse',
          )}
        />
      )}
      <span>{update.label}</span>
    </button>
  );
}
