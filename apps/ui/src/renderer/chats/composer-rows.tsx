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
 * above the text; the two describing how this turn thinks (model, effort) sit
 * below beside the actions, where the pinned Send button makes wrapping wrong.
 *
 * So there is no measurement here at all, and no `…`: every control is on
 * screen, which is what the row could never promise before.
 *
 * **The top row does not wrap.** It used to, on the argument that a card
 * growing upward is a card growing with its own content — and in a 672px card
 * five chips whose labels are user data (a folder name, a branch, a profile)
 * routinely need more than one line, so `auto-approve` sat alone under the
 * other four. Reported, and fairly: the four-then-one arrangement reads as a
 * layout accident rather than a second row of anything, and it moves under the
 * user as the folder name changes.
 *
 * What replaced it is neither of the two options this block already weighed. It
 * is not the overflow `…` (that HID controls — the failure the wrap was chosen
 * over), and it is not a clip. The chips SHRINK: each label is already a
 * `truncate` span with the icon and chevron as `shrink-0` siblings, so squeezing
 * one shortens its text and leaves it reading as a picker. Nothing is hidden,
 * nothing moves to a second line, and the chip that gives up width is whichever
 * one is longest — which is the user's own folder or branch name, the one place
 * an ellipsis costs least because the full value is on hover.
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
    // NO bottom padding: "отступа практически должно не быть между директорией
    // и текст-эйрией". The row is a caption for the card, not a sibling block
    // above it, and the 6px that used to sit here read as the latter. What air
    // remains is the chips' OWN box — they are `h-8` around ~12px of text — and
    // that is the chip being a chip rather than a gap between two things.
    // No blanket shrink rule here, deliberately. Applied to every child, flex
    // takes width off ALL of them — `claude` became `cla…` beside a folder chip
    // still showing twenty characters, which is the wrong chip losing its
    // label. Which chips may give up width is a property of what they hold, so
    // each says so itself (`shrink` on the folder, branch and profile chips —
    // the three whose text is user data and whose full value is on hover). The
    // short fixed-vocabulary ones keep their `shrink-0` and stay whole.
    <div className="flex items-center gap-x-0.5 px-1 empty:hidden">
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
      {/* ONE LINE, at every width. Reported flatly — "они расползаются на две
          строки. Никогда такого быть не должно" — against a 620px composer
          where the three pickers filled the first line and the approval chip
          and the context ring dropped onto a second.

          This box used to WRAP, on a measurement that no longer holds: shrinking
          the chips was rejected because it "truncated their chevrons away", and
          it does not — `Select`'s trigger keeps its icon and its chevron
          `shrink-0` and gives up the LABEL, which is `truncate`d. (That is the
          same arrangement the `flexible` prop already ships for the
          run-configuration editor's rows; what was missing here was the second
          half of it.) So the chips narrow in place instead of stacking, and the
          row's height stops depending on how many of them a run happens to
          show.

          Three rules make that work, and none of them is optional:
          `[&>*]` overrides the chip's own `shrink-0` so a direct child may
          narrow; the trigger rule makes the BUTTON follow its wrapper, without
          which the wrappers shrink on schedule while the buttons keep their
          content width and overlap each other's text; and the labels
          themselves already truncate. */}
      <div className="flex min-w-0 flex-1 items-center gap-x-0.5 [&>*]:min-w-0 [&>*]:shrink [&_[data-menu-trigger]]:w-full [&_[data-menu-trigger]]:min-w-0">
        {children}
      </div>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </div>
  );
}
