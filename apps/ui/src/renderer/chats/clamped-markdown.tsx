import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { MarkdownContent } from './markdown-content';
import { useThreadFlag } from './thread-ui-memory';

/** Whether a text runs past `lines` lines once drawn, judged from the text itself. */
export function isLongMarkdown(text: string, lines: number): boolean {
  return text.split('\n').length > lines || text.length > lines * 80;
}

/**
 * Any content clamped to a few lines with a bottom fade and a Show more / Show
 * less toggle, remembered within the thread. `long` says whether the content
 * runs past the clamp; the caller judges it from what it draws.
 */
export function ClampedBlock({
  children,
  long,
  lines,
  slot,
  toggleClassName,
  memoryKey,
}: {
  children: React.ReactNode;
  long: boolean;
  lines: number;
  slot: string;
  toggleClassName?: string;
  /** Where Show more is remembered within the thread. */
  memoryKey?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useThreadFlag(memoryKey, false);
  const clamped = !expanded && long;
  return (
    <div data-slot={slot} data-clamped={clamped ? 'true' : undefined}>
      {/*
        `overflow-clip`, not `overflow-hidden`: `hidden` also makes the box a
        scroll container, which focusing a descendant (a fence's Copy button)
        scrolls for good, so the clamp then cuts through its first line.
      */}
      <div
        className={cn(clamped && 'overflow-clip')}
        style={
          clamped
            ? {
                maxHeight: `${lines * 1.8}em`,
                maskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 40%, transparent)',
              }
            : undefined
        }>
        {children}
      </div>
      {long ? (
        <button
          type="button"
          data-slot={`${slot}-toggle`}
          className={cn(
            'mt-1.5 flex items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground',
            toggleClassName,
          )}
          onClick={() => setExpanded((value) => !value)}>
          {expanded ? (
            <>
              <ChevronUp aria-hidden="true" className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown aria-hidden="true" className="size-3" /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A text drawn as markdown and clamped to a few lines with a bottom fade and
 * a Show more / Show less toggle, remembered within the thread.
 */
export function ClampedMarkdown({
  text,
  lines,
  slot,
  className,
  toggleClassName,
  memoryKey,
}: {
  text: string;
  lines: number;
  slot: string;
  /** The markdown's own text size and colour. */
  className?: string;
  toggleClassName?: string;
  /** Where Show more is remembered within the thread. */
  memoryKey?: string;
}): React.JSX.Element {
  return (
    <ClampedBlock
      long={isLongMarkdown(text, lines)}
      lines={lines}
      slot={slot}
      toggleClassName={toggleClassName}
      memoryKey={memoryKey}>
      <MarkdownContent content={text} className={className} />
    </ClampedBlock>
  );
}
