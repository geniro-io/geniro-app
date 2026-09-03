import { Check } from 'lucide-react';

import { cn } from './utils';

/**
 * How many of a set of options one answer may name.
 *
 * This is the control's PRIMARY axis, not a detail of it: the arity decides the
 * shape of the indicator, and the shape of the indicator is the only thing that
 * tells a reader — before they click — whether a second pick will add to the
 * first or replace it.
 *
 * - `many` — a square box with a tick, the checkbox every interface uses for
 *   "as many as apply". Picks accumulate; clicking a chosen row clears it.
 * - `one` — a round dot, the radio every interface uses for "one of these".
 *   Picking replaces the previous pick.
 * - `none` — NO indicator at all. For the case where the click is itself the
 *   submission, so nothing is ever left sitting in a checked box; drawing an
 *   empty one there would promise a staging step that does not exist, and the
 *   user would go looking for the button that confirms it.
 */
export type OptionArity = 'many' | 'one' | 'none';

/** What the group's accessible name says about how many may be picked. */
const ARITY_LABEL: Record<OptionArity, string> = {
  many: 'pick as many as apply',
  one: 'pick one',
  none: 'picking one answers straight away',
};

/**
 * A set of pickable answer options.
 *
 * **Flow layout, not a column.** Options arrive as anything from three words to
 * a full sentence, and neither shape can be laid out well by the rule that suits
 * the other: a fixed column wastes most of its width on short labels, while a
 * row of nowrap pills turns long ones into a horizontally ragged brick wall.
 * Each option is therefore `max-w-full` inside a wrapping flex — short ones sit
 * together on a line, a long one takes the line it needs and wraps its own text.
 *
 * **Selected state is stated twice**, by the indicator and by a tinted fill, and
 * that redundancy is deliberate: the fill is what is legible while scanning a
 * dozen rows at a glance, the indicator is what is legible on the single row
 * being looked at.
 *
 * Toggle buttons rather than `role="radio"`/`role="checkbox"`: an ARIA radio
 * group promises arrow-key navigation and a single tab stop, and a half-built
 * one is worse for a keyboard user than an honest list of buttons. The arity is
 * carried to a screen reader by the group's own name instead — see
 * {@link ARITY_LABEL} — so it is announced, not only drawn.
 */
export function OptionList({
  options,
  selected,
  arity,
  disabled = false,
  inert = false,
  label = 'Options',
  onPick,
  className,
}: {
  options: readonly string[];
  /** The labels currently picked. Ignored entirely when `arity` is `none`. */
  selected: readonly string[];
  arity: OptionArity;
  disabled?: boolean;
  /**
   * Unpressable like {@link disabled}, and drawn at FULL strength.
   *
   * For a card that SHOWS a question somebody else answers — a call thread's
   * question card, where the options are the whole point of the row and the
   * reader is not the one who can pick. Borrowing `disabled` there took its
   * tint with it and dropped the option text to about 3.1:1 on the light
   * theme, under the 4.5:1 AA floor for 14px — so the faintest thing on the
   * card was the content it exists to show. It keeps the real `disabled`
   * attribute, since "you cannot press this" is exactly what it means to
   * a screen reader and to the pointer; only the dimming is dropped.
   */
  inert?: boolean;
  /** What this set of options is FOR — prefixes the group's accessible name. */
  label?: string;
  onPick: (option: string) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`${label} — ${ARITY_LABEL[arity]}`}
      className={cn(
        'flex gap-1.5',
        // A checklist is read DOWN its boxes, so `many` gets a column: in a
        // wrapping flow every box sits at a different x, and the one thing the
        // eye uses to count what it has ticked is gone. The other two arities
        // have nothing to align and keep the flow, which is what lets six short
        // options occupy one line instead of six.
        arity === 'many' ? 'flex-col items-start' : 'flex-wrap',
        className,
      )}>
      {options.map((option, index) => {
        const chosen = arity !== 'none' && selected.includes(option);
        return (
          // Index-composite keys: one payload may repeat an option label.
          <button
            key={`${index}-${option}`}
            type="button"
            disabled={disabled || inert}
            // Only where there is a state to be in. On the `none` path the
            // press sends the answer, and a button that reports itself
            // unpressed after being pressed is a lie about what just happened.
            aria-pressed={arity === 'none' ? undefined : chosen}
            onClick={() => onPick(option)}
            className={cn(
              'inline-flex max-w-full cursor-pointer items-start gap-2 rounded-md border px-2 py-1 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none',
              inert ? 'disabled:opacity-100' : 'disabled:opacity-50',
              chosen
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border hover:bg-accent hover:text-accent-foreground',
            )}>
            {arity === 'none' ? null : (
              <span
                aria-hidden="true"
                data-slot="option-indicator"
                className={cn(
                  // `mt-0.5` rather than centring the row: a label that wraps
                  // to three lines would otherwise float its box against the
                  // middle line, where it reads as belonging to that line
                  // rather than to the option.
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors',
                  arity === 'many' ? 'rounded-[4px]' : 'rounded-full',
                  chosen
                    ? 'border-primary bg-primary text-primary-foreground'
                    : // NOT `border-input`: that token is tuned for a field's
                      // own edge against page cream, where it is meant to
                      // recede — at 16px it disappeared, and an invisible
                      // checkbox is exactly the state this control exists to
                      // make visible.
                      'border-muted-foreground/50',
                )}>
                {chosen ? (
                  arity === 'many' ? (
                    <Check className="size-3" strokeWidth={3} />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary-foreground" />
                  )
                ) : null}
              </span>
            )}
            <span className="min-w-0 break-words">{option}</span>
          </button>
        );
      })}
    </div>
  );
}
