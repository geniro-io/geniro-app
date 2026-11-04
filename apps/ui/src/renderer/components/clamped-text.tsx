import { cva } from 'class-variance-authority';
import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from './ui/utils';

const clampedVariants = cva('m-0 whitespace-pre-wrap break-words', {
  variants: {
    clamp: {
      2: 'line-clamp-2',
      3: 'line-clamp-3',
      4: 'line-clamp-4',
      none: '',
    },
  },
});

/**
 * Text held to a few lines, with a Show more / Show less toggle that appears
 * only when the text is cut. Given `onOpen`, the toggle opens the whole text
 * elsewhere instead of unfolding it in place.
 */
export function ClampedText({
  text,
  lines,
  slot,
  className,
  toggleClassName,
  onOpen,
  openLabel = 'Open full text',
  actions,
}: {
  text: string;
  lines: 2 | 3 | 4;
  slot: string;
  className?: string;
  toggleClassName?: string;
  onOpen?: () => void;
  openLabel?: React.ReactNode;
  /** Controls drawn beside the toggle, shown whether or not the text is cut. */
  actions?: React.ReactNode;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    if (expanded) {
      return;
    }
    const measure = (): void => {
      const body = bodyRef.current;
      if (body !== null) {
        setOverflowing(body.scrollHeight > body.clientHeight);
      }
    };
    measure();
    const body = bodyRef.current;
    if (body === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p
        ref={bodyRef}
        data-slot={slot}
        className={cn(
          clampedVariants({ clamp: expanded ? 'none' : lines }),
          className,
        )}>
        {text}
      </p>
      {overflowing || expanded || actions !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {overflowing || expanded ? (
            <button
              type="button"
              aria-expanded={onOpen === undefined ? expanded : undefined}
              onClick={onOpen ?? (() => setExpanded((current) => !current))}
              className={cn(
                'self-start rounded-md text-xs font-medium text-muted-foreground hover:text-foreground',
                toggleClassName,
              )}>
              {onOpen !== undefined
                ? openLabel
                : expanded
                  ? 'Show less'
                  : 'Show more'}
            </button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
