import { cn } from '../components/ui/utils';

/**
 * How many lines the composer's textarea may grow to before it starts to
 * scroll.
 *
 * REPORTED as "вот этот текст в area должен расширяться, когда мы там пишем …
 * сейчас его максимальное расширение составляет, не знаю, 3 строки. Оно должно
 * быть там 7 строк". It did not expand at ALL: both composers were fixed boxes
 * (`rows` + a `min-h-*` floor + `resize-none`), so a fourth line scrolled the
 * first one out of sight while the box stayed the same height — which is what
 * "maximum expansion is about 3 lines" describes from the outside.
 */
export const COMPOSER_MAX_LINES = 7;

/**
 * The growth rule both composers share — content-sized, capped at
 * {@link COMPOSER_MAX_LINES}.
 *
 * `field-sizing: content` rather than a resize effect: the browser already
 * measures the text on every keystroke, and the JS alternative is a ref plus a
 * layout write per input event that has to be re-run on every path that changes
 * the value from outside (a restored draft, a skill picked from the menu, a
 * queued message put back). One declaration cannot get out of step with the
 * value the way that effect can.
 *
 * The ceiling is expressed in `lh` so it stays SEVEN LINES rather than a pixel
 * count that silently becomes six at another font size — the composer is
 * `text-base` under `md` and `text-sm` above it, so a hardcoded height would be
 * wrong on one of them. The `+1.375rem` is the box's own vertical padding
 * (`pt-3.5` over `py-2`'s bottom half), which `max-height` includes under
 * border-box sizing; without it the cap lands a line and a bit early.
 *
 * The `rows` attribute stays on both call sites as the fallback: a runtime
 * without `field-sizing` ignores this and gets exactly the fixed box that
 * shipped before, never a one-line field.
 *
 * WRITTEN OUT, not interpolated from {@link COMPOSER_MAX_LINES}: Tailwind
 * generates utilities by SCANNING source text for class candidates, so a
 * template hole here produces no rule at all and the cap silently disappears.
 * The constant is what the spec asserts against, which is what keeps the two
 * in step.
 */
export const COMPOSER_TEXTAREA_GROWTH =
  'field-sizing-content max-h-[calc(7lh+1.375rem)]';

/**
 * The one Cursor-style composer shell shared by BOTH message surfaces — the
 * new-run composer and the open transcript's follow-up composer — so they
 * stay visually identical: a rounded card that ring-highlights while the
 * textarea inside has focus. Content is the caller's (textarea on top, a
 * controls row underneath).
 */
export function ComposerCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      // Named, so "is this chip inside the card or above it" is answerable —
      // which is a real distinction on this surface: the chips that describe
      // where a run HAPPENS sit above the card and the ones that decide how the
      // turn thinks sit inside it, and the boundary between the two is the
      // card's own border.
      data-slot="composer-card"
      className={cn(
        'rounded-2xl border border-border bg-card shadow-panel-md transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30',
        className,
      )}>
      {children}
    </div>
  );
}
