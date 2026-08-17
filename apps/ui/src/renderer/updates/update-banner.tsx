import { ArrowDownToLine, TriangleAlert, X } from 'lucide-react';

import type { UpdateState } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { ProgressBar } from '../components/ui/progress-bar';
import { cn } from '../components/ui/utils';
import { updateStatusLine } from './update-status';

/**
 * Should the app-wide update strip be on screen?
 *
 * Pure, and separate from the component, because the interesting part is not
 * the markup — it is the three rules:
 *
 * - An install the user STARTED is never hidden. Dismissal applies to an offer,
 *   not to a download already running or to a bundle already swapped.
 * - An offer stays dismissed for the version it was about. A newer release is a
 *   new offer, and dismissing v1.4.0 must not silence v1.5.0.
 * - A failed CHECK is not a banner. GitHub being unreachable is not something
 *   the user asked about or can act on; it belongs in Settings, next to the
 *   button that asks. A failed INSTALL is the opposite — they pressed a button
 *   and are owed the outcome — which is what `engaged` distinguishes.
 */
export function updateBannerVisible(
  state: UpdateState | null,
  dismissedVersion: string | null,
  engaged: boolean,
): boolean {
  if (!state) {
    return false;
  }
  switch (state.phase) {
    case 'downloading':
    case 'installing':
    case 'ready':
      return true;
    case 'available':
      return state.version !== dismissedVersion;
    case 'error':
      return engaged;
    default:
      return false;
  }
}

/**
 * The app-wide "there is a newer Geniro" strip.
 *
 * Sits with {@link ConnectionBanner} above every view, for the same reason: it
 * is about the app rather than about whichever screen happens to be open. It is
 * dismissible where that one is not — a dropped daemon connection is a fact
 * still true after you close the message, while an available update is an offer,
 * and an offer you have declined should stop asking.
 */
export function UpdateBanner({
  state,
  onInstall,
  onDismiss,
  className,
}: {
  state: UpdateState;
  onInstall: () => void;
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  const failed = state.phase === 'error';
  const working = state.phase === 'downloading' || state.phase === 'installing';
  return (
    <div
      // `status`, not `alert`: an available update is a standing condition, and
      // the strip re-renders on every percent of the download — an assertive
      // role would re-interrupt a screen reader each time.
      role="status"
      className={cn(
        'flex flex-col gap-1 border-b px-3 py-1.5 text-xs',
        failed
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : // Full `accent`, not a fraction of it: `--accent` (#f4e5d3) and
            // `--background` (#f5f1eb) are close enough in this warm palette
            // that any transparency leaves the strip invisible against the
            // page — measured at 40%, where only the bottom border read as a
            // separation at all.
            'border-border bg-accent text-foreground',
        className,
      )}>
      <div className="flex items-center gap-2">
        {failed ? (
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <ArrowDownToLine aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium">{updateStatusLine(state)}</span>{' '}
          {/* main's own sentence — the checksum that did not match, or the
              command that updates an install the app cannot replace itself. */}
          {state.message}
        </span>
        {state.phase === 'available' ? (
          state.canInstall ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-6 shrink-0 gap-1 px-2 text-[11px]"
              onClick={onInstall}>
              Update now
            </Button>
          ) : null
        ) : null}
        {/* An install in flight has nothing to dismiss: closing the strip would
            hide a download that is still using the network and a swap that is
            about to restart the app. */}
        {working || state.phase === 'ready' ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="size-6 shrink-0"
            onClick={onDismiss}>
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        )}
      </div>
      {working ? (
        <ProgressBar
          fraction={state.phase === 'installing' ? null : state.progress}
          label={`Update ${state.version} progress`}
        />
      ) : null}
    </div>
  );
}
