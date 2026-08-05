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
 * Always `aria-hidden`: it decorates a row that already says in words what is
 * happening, so announcing it again would only interrupt a screen reader.
 */
export function Spinner({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <Loader2
      aria-hidden="true"
      className={cn('size-3 shrink-0 animate-spin text-primary', className)}
    />
  );
}
