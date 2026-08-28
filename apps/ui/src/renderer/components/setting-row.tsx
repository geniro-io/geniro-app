import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './ui/utils';

/**
 * One labelled setting: the name on the left, the control on the right.
 *
 * The alternative is a wrapping chip ROW, which is right for the composer —
 * chips there sit under a message box and read as a sentence about the next
 * turn — and wrong on a screen whose settings are read rather than written:
 * they wrap onto a second line whose contents MOVE as the model changes, so the
 * same setting sits somewhere different each time the screen is opened, and a
 * bare chip never says which axis it is (`high` is an effort only if you
 * already knew). A fixed label column gives every setting one address, and
 * nothing can wrap because the control's cell truncates instead
 * (`minmax(0,1fr)` over `min-w-0`).
 *
 * Shared by the run-configuration editor and the graph node inspector. It was
 * private to the editor until the inspector needed the same thing; a second
 * copy is how the two would come to disagree about the column width, the gap,
 * or where a hint sits.
 *
 * **The ROW goes with its control.** Every picker in this app renders NOTHING
 * when its axis has no values (the standing "a picker with nothing to pick is
 * not drawn" rule), and a labelled row wrapped around nothing is a label with a
 * hole under it — which in a fixed column is louder than the missing chip ever
 * was. Callers drop the whole row, never just its contents.
 */
const settingRow = cva('grid items-center gap-x-3 px-3 py-2', {
  variants: {
    /**
     * How much of the row the label column takes — and, for `compact`, whether
     * there are two columns at all.
     *
     * `default` (7rem) is the dialog's, where the editor has the width to spend.
     *
     * `compact` is the builder's inspector, a panel the user can drag down to
     * 240px, and it STACKS below `17rem` of container width rather than let the
     * VALUE give way. REPORTED against a chip reading `Defa…`, which has said
     * nothing at all: "они должны влезать в блок".
     *
     * The threshold is arithmetic, not taste. Two columns need
     * `5.5rem` of label + `12px` of gap + the row's `24px` of padding + the
     * widest value these rows carry, which is a `Default profile` chip at
     * 128px — so `threshold ≥ 5.5rem + 164px`. This app's root font is **15px**
     * (`--font-size` in `global.css`), which makes that 16.43rem, and 16px roots
     * put it at 15.75rem; `17rem` clears both with room. It is expressed in REM
     * on purpose: the label column is rem-sized too, so a breakpoint in rem
     * tracks it if the root ever changes, where a px one would drift out of step.
     *
     * Stacked, the control gets the row's whole width (185px at the 240px
     * minimum, against the 128px it needs) and every value fits. It costs a
     * second line per row, which is the right way round — a panel squeezed that
     * far has traded width for height by definition, and the alternative is a
     * column of ellipses.
     *
     * A CONTAINER query, not a viewport one: the card is what the row has to fit
     * inside, and its width is set by a drag handle rather than by the window.
     * The card carries `@container` at the call site.
     */
    width: {
      default: 'grid-cols-[7rem_minmax(0,1fr)]',
      compact:
        'grid-cols-1 gap-y-1 @[17rem]:grid-cols-[5.5rem_minmax(0,1fr)] @[17rem]:gap-y-0',
    },
  },
  defaultVariants: { width: 'default' },
});

export function SettingRow({
  label,
  hint,
  width,
  children,
}: {
  label: string;
  /** One line under the control — what flipping this does, never what it is. */
  hint?: string;
  children: React.ReactNode;
} & VariantProps<typeof settingRow>): React.JSX.Element {
  return (
    <div data-slot="setting-row" className={cn(settingRow({ width }))}>
      <span className="text-sm text-muted-foreground">{label}</span>
      {/* `[&>*]:max-w-full` is what makes the truncation real, and it was
          missing. `min-w-0` lets the CELL shrink; it says nothing about the
          control inside, which keeps its intrinsic width and simply overhangs.
          Invisible in the dialog, where the cell is wide enough — measured in
          the builder's inspector at its 240px minimum, where a `Default
          profile` chip ran 38px past its column and over the card's edge.
          Capping the child is what hands the overflow to the chip's own
          `truncate` span, which is where the ellipsis lives. */}
      <div className="flex min-w-0 flex-col items-start gap-0.5 [&>*]:max-w-full">
        {children}
        {hint === undefined ? null : (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  );
}
