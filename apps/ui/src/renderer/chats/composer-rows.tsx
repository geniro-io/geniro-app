import * as React from 'react';

/**
 * The composer's control rows — the run-identity chips ABOVE the card, the
 * turn's own settings and the send/stop actions INSIDE it, below the textarea.
 *
 * ONE pair for BOTH composers (the new-run card and the open transcript's
 * follow-up card): they carry the same rows, and a rule fixed in one copy is
 * exactly what the split exists to keep from drifting.
 *
 * **Why the top row sits outside the card.** It used to be the card's first
 * band, which read as part of the input: a bordered box whose top strip was
 * pickers and whose bottom was the text you type. What those chips actually
 * state is where the run HAPPENS — its agent, folder, branch, permission
 * posture — which is context for the message, not part of it. Lifting them out
 * puts the card's border around the message alone and leaves the chips as free
 * pills above it, which is also how the reference this was drawn from reads.
 *
 * **Why two rows, and why no overflow menu.** These replaced a single row under
 * the textarea that measured its own children and folded whatever did not fit
 * into a trailing `…` popover. That machinery was written against a real
 * failure — at 900px the last chips ran UNDER the send button and squeezed the
 * folder chip to zero width — but it solved it by HIDING controls: the widest
 * labels are user data (a folder name, a branch, a model alias), so the chip
 * that disappeared was routinely the one naming where the run would happen.
 *
 * Splitting by KIND removes the pressure instead of rationing it. The chips
 * describing what the run is (target, folder, branch, trigger, approval) sit
 * above the text and are free to wrap, because nothing shares that line with
 * them — wrapping there grows the card upward, which is what a card growing
 * with its own content should do. The two chips describing how this turn
 * thinks (model, effort) sit below beside the actions, where the pinned Send
 * button makes wrapping wrong; they are short, fixed-vocabulary labels, and
 * they truncate rather than push.
 *
 * So there is no measurement here at all, and no `…`: every control is on
 * screen, which is what the row could never promise before.
 */
export function ComposerTopRow({
  children,
}: {
  /** The run-identity chips — `Chip`s and ghost `Select`s. */
  children: React.ReactNode;
}): React.JSX.Element | null {
  // `toArray` drops literal `null` children; a chip COMPONENT returning null
  // still counts here, which is why emptiness is not tested on this list — a
  // row of three components that all render nothing collapses to zero height
  // on its own, and the padding is the only thing that would show.
  if (React.Children.count(children) === 0) {
    return null;
  }
  return (
    // `px-1` rather than the card's `px-2`: the chips have their own inner
    // padding, so aligning their TEXT with the textarea's would need the
    // padding of neither. One notch in keeps the row visually hung off the
    // card's left edge without indenting it.
    // `pb-1.5` is the only gap to the card — the row is a caption for it, and
    // spacing it like a sibling block would break that reading.
    <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 px-1 pb-1.5 empty:hidden">
      {children}
    </div>
  );
}

export function ComposerBottomRow({
  children,
  actions,
}: {
  /** The per-turn chips: model, effort, and the context meter beside them. */
  children: React.ReactNode;
  /**
   * Send / Stop. Never wraps and never shrinks — the one control that aborts
   * work the user is watching must stay where it was.
   */
  actions: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 p-2">
      {/* Deliberately NOT `overflow-hidden`: every chip's menu is an absolutely
          positioned descendant, so a clip here cuts each one down to the row's
          own height — the menus simply vanish — and a clipped box is still a
          scroll container, so focusing a menu's search field scrolled the row
          sideways under its own chips. */}
      {/* Wrapping happens INSIDE this box, so the actions beside it never move
          — which is what made wrapping wrong on the old single row and makes it
          right here. Measured at 760px: without it "default effort" ran clean
          UNDER Send, and forcing the chips to shrink instead truncated their
          chevrons away, so they stopped reading as pickers at all. Stacking
          keeps both legible. `[&>*]` still overrides the chip's own `shrink-0`
          for the last resort — one chip wider than the whole box. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 [&>*]:min-w-0 [&>*]:shrink">
        {children}
      </div>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </div>
  );
}
