import { SlidersHorizontal, Zap } from 'lucide-react';

import type { FastAction } from '../../shared/contracts';
import { Button } from '../components/ui/button';

/**
 * The user's own buttons, under the composer on the new-chat screen.
 *
 * One press writes that action's description into the message box — and that is
 * the whole of it. It sends nothing and it touches no chip, so an action is
 * usable under WHATEVER setup the composer is already carrying: the same
 * "review the diff and report findings" is one press whether the folder is this
 * repo or another and whether the agent is claude or cursor.
 *
 * That independence is the feature. An action that also chose the folder and
 * the model would be a second, invisible source of the run's configuration, and
 * pressing one would move chips the user had just set by hand.
 *
 * The set is EMPTY for most users and draws nothing at all then, on the rule
 * the composer shelf follows: a surface that costs space for a feature nobody
 * has configured is a surface in the way.
 */
export function FastActionBar({
  actions,
  onPress,
  onManage,
}: {
  actions: readonly FastAction[];
  onPress: (action: FastAction) => void;
  /** Open the screen where they are edited, or undefined where there is none. */
  onManage?: () => void;
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
        <Button
          key={action.id}
          type="button"
          variant="outline"
          size="sm"
          data-slot="fast-action"
          // The description in full, because the button shows only the name and
          // the text is about to become the user's own message — the one moment
          // before a press when reading it can still change the answer.
          title={action.description}
          aria-label={`Write the fast action “${action.name}” into the message`}
          className="h-7 max-w-64 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs"
          onClick={() => onPress(action)}>
          <Zap aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{action.name}</span>
        </Button>
      ))}
      {/* The way back to where these are written, from where they are used. It
          rides the bar rather than sitting beside the `+`, because the bar is
          the only place the actions are visible — and it is drawn only when
          there ARE some, since a manage button over an empty set is the surface
          this bar refuses to be. Settings' own nav entry is how the first one
          gets made. */}
      {onManage ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="fast-action-manage"
          aria-label="Edit your fast actions"
          title="Edit your fast actions"
          className="size-7 shrink-0 text-muted-foreground"
          onClick={onManage}>
          <SlidersHorizontal className="size-3.5 shrink-0" />
        </Button>
      ) : null}
    </div>
  );
}
