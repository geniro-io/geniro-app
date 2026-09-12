import { Chip } from '../components/ui/chip';
import { Spinner } from '../components/ui/spinner';

/**
 * How many of this board's tasks have an agent working right now.
 *
 * It sits on the board header, beside the autopilot chip, and it was ASKED FOR
 * there: "это «running» нужно, видимо, в хедер поместить рядом со «автопилотом»
 * и там какой-нибудь лодер показывать, если он работает. То есть вынести это в
 * хедер." Before that it was counted on the intake column's autopilot band,
 * which is the one column a running card is guaranteed to have LEFT — so the
 * board read `2 running` under a `To do` header reading `0`, with both cards
 * sitting in `In progress` beside it.
 *
 * A readout and not a control: a static {@link Chip}, no chevron, nothing to
 * press. The count is a fact about the board and there is no setting behind it.
 *
 * It is deliberately NOT part of the autopilot chip, and that is the reason it
 * is a separate component rather than another line in `AutopilotControl`: the
 * daemon counts every live run of this project's tasks, including the ones a
 * user started by hand from a card. Folding that figure into a control named
 * Autopilot would credit it with work it did not start — and would have to
 * disappear the moment the autopilot is switched off, while the agents it is
 * counting carry on working.
 *
 * Drawn only while something IS running: a fixed `0 running` in a header is a
 * readout nobody reads, and its absence says the same thing.
 */
export function RunningTasks({
  running,
}: {
  /** From the daemon's queue — null while unread. */
  running: number | null;
}): React.JSX.Element | null {
  if (running === null || running <= 0) {
    return null;
  }
  return (
    <Chip
      data-slot="running-tasks"
      tone="active"
      title="Tasks with an agent working on them right now, in their own worktree.">
      <Spinner className="size-3.5" />
      {running === 1 ? '1 running' : `${running} running`}
    </Chip>
  );
}
