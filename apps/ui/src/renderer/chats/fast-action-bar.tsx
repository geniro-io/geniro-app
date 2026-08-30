import { Folder, Play, Zap } from 'lucide-react';

import type { RunConfig } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { shortenPath } from './directory-select';
import { workflowSlugOf } from './run-config';

/**
 * The user's own buttons, under the composer on the new-chat screen.
 *
 * One press is a whole chat: the action carries the folder, the branch, the
 * agent and its options, and — when it names one — the opening message, so the
 * chat is already working before the user has typed anything. That is the whole
 * of what these are for; a saved setup you still have to write a message into
 * is the thing they were before, and both are still possible (an action with no
 * message seeds the composer and stops).
 *
 * The set is EMPTY for most users and draws nothing at all then, on the rule
 * the composer shelf follows: a surface that costs space for a feature nobody
 * has configured is a surface in the way.
 */
export function FastActionBar({
  actions,
  onRun,
  disabled = false,
}: {
  actions: readonly RunConfig[];
  onRun: (action: RunConfig) => void;
  /** A turn is already running — pressing would queue nothing and do nothing. */
  disabled?: boolean;
}): React.JSX.Element | null {
  if (actions.length === 0) {
    return null;
  }
  return (
    <div
      data-slot="fast-action-bar"
      aria-label="Fast actions"
      role="group"
      // WRAPS, unlike the composer shelf directly above the textarea. These sit
      // BELOW the card, where growing downward costs the user nothing — while a
      // row above it pushes the textarea up the pane, which is the defect that
      // shelf was rebuilt around. A user with nine actions gets two lines.
      className="flex flex-wrap items-center justify-center gap-1.5">
      {actions.map((action) => (
        <FastActionButton
          key={action.id}
          action={action}
          disabled={disabled}
          onRun={onRun}
        />
      ))}
    </div>
  );
}

/**
 * One action. The NAME is the label; what it opens is the tooltip.
 *
 * The glyph says which of the two kinds it is — a bolt for one that fires its
 * own message, an outline play for one that only fills the chips in. They are
 * different actions and pressing them has visibly different consequences, so
 * the button says which before it is pressed rather than after.
 */
function FastActionButton({
  action,
  disabled,
  onRun,
}: {
  action: RunConfig;
  disabled: boolean;
  onRun: (action: RunConfig) => void;
}): React.JSX.Element {
  const sends = action.firstMessage !== null;
  const target = workflowSlugOf(action.target) ?? action.target;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="fast-action"
      data-sends={sends ? 'message' : 'setup'}
      disabled={disabled}
      title={[
        sends ? `Starts ${target} and sends:` : `Sets up ${target} in`,
        sends ? action.firstMessage : shortenPath(action.cwd),
      ].join('\n')}
      aria-label={
        sends
          ? `Start a chat from the fast action ${action.name}`
          : `Set the composer up from the fast action ${action.name}`
      }
      className="h-7 max-w-64 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs"
      onClick={() => onRun(action)}>
      {sends ? (
        <Zap aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <Play aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">{action.name}</span>
      {/* The folder, only where the name does not already carry it. A machine
          holds several checkouts and the actions across them are otherwise
          told apart by a tooltip nobody hovers. */}
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <Folder aria-hidden="true" className="size-3 shrink-0" />
        <span className="max-w-24 truncate">{folderLeaf(action.cwd)}</span>
      </span>
    </Button>
  );
}

/** The folder's own name — the last segment, which is what identifies it. */
function folderLeaf(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? cwd;
}
