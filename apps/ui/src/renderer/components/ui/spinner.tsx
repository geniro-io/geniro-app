import { Loader2 } from 'lucide-react';

import { cn } from './utils';

/**
 * The app's ONE "something is running" spinner.
 *
 * A tiny primitive, and deliberately so: the same three classes were written
 * inline at four call sites (the tool group's header, a call block's status,
 * and both live transcript rows), which is exactly the duplication
 * `renderer-components.md` forbids — a change to the size or the tone would
 * have had to be made four times and could silently drift between them.
 *
 * `frames` draws the same arc from an animated picture (`spinner-frames` in
 * `styles/global.css`), for a surface showing many at once: a CSS spin, smooth
 * or in steps, repaints the page around every spinner on each frame it moves,
 * while one picture's frames advance for every copy together. The picture is a
 * mask over `currentColor`, so the tone still comes from the theme. It shows the
 * still arc when the system asks for less motion.
 *
 * Always `aria-hidden`: it decorates a row that already says in words what is
 * happening, so announcing it again would only interrupt a screen reader.
 */
export function Spinner({
  className,
  pace = 'smooth',
}: {
  className?: string;
  pace?: 'smooth' | 'frames';
}): React.JSX.Element {
  if (pace === 'frames') {
    return (
      <span
        aria-hidden="true"
        data-slot="spinner"
        className={cn(
          'inline-flex size-3 shrink-0 spinner-frames text-primary',
          className,
        )}>
        <Loader2 className="size-full" />
      </span>
    );
  }
  return (
    <Loader2
      aria-hidden="true"
      className={cn('size-3 shrink-0 animate-spin text-primary', className)}
    />
  );
}
