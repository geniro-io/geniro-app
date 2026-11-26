import { cva } from 'class-variance-authority';
import { Loader, Loader2 } from 'lucide-react';

import { cn } from './utils';

const spinnerVariants = cva('size-3 shrink-0 animate-spin text-primary', {
  variants: {
    pace: {
      smooth: '',
      stepped: 'spinner-stepped',
    },
  },
  defaultVariants: { pace: 'smooth' },
});

/**
 * The app's ONE "something is running" spinner.
 *
 * A tiny primitive, and deliberately so: the same three classes were written
 * inline at four call sites (the tool group's header, a call block's status,
 * and both live transcript rows), which is exactly the duplication
 * `renderer-components.md` forbids — a change to the size or the tone would
 * have had to be made four times and could silently drift between them.
 *
 * `stepped` turns a spoked wheel eight steps a second instead of a smooth arc:
 * a smooth spin repaints on every display frame, which a canvas showing many
 * at once pays for in GPU and renderer time.
 *
 * Always `aria-hidden`: it decorates a row that already says in words what is
 * happening, so announcing it again would only interrupt a screen reader.
 */
export function Spinner({
  className,
  pace = 'smooth',
}: {
  className?: string;
  pace?: 'smooth' | 'stepped';
}): React.JSX.Element {
  const Glyph = pace === 'stepped' ? Loader : Loader2;
  return (
    <Glyph
      aria-hidden="true"
      className={cn(spinnerVariants({ pace }), className)}
    />
  );
}
