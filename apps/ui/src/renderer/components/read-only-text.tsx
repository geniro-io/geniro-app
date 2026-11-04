import { Maximize2 } from 'lucide-react';
import { useState } from 'react';

import { ClampedText } from './clamped-text';
import { MarkdownViewerDialog } from './markdown-editor-dialog';
import { cn } from './ui/utils';

/** The look of a small text action beside a read-only text: Open full text, Edit. */
export const TEXT_ACTION_CLASS =
  'inline-flex items-center gap-1 self-start rounded-md text-xs font-medium text-primary hover:text-primary/80 hover:underline';

/**
 * A long text edited somewhere else: its first lines, and the whole of it in
 * the read-only text window when it is cut.
 */
export function ReadOnlyText({
  title,
  text,
  lines = 4,
  slot = 'read-only-text',
  emptyLabel = 'No text yet.',
  className,
  actions,
}: {
  /** Names the text in the window's title. */
  title: string;
  text: string;
  lines?: 2 | 3 | 4;
  slot?: string;
  emptyLabel?: string;
  className?: string;
  /** Controls beside Open full text, such as an Edit for what this scope adds. */
  actions?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (text.trim() === '') {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p
          data-slot={slot}
          className={cn('m-0 text-sm text-muted-foreground', className)}>
          {emptyLabel}
        </p>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {actions}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <ClampedText
        text={text}
        lines={lines}
        slot={slot}
        className={cn('text-sm text-muted-foreground', className)}
        onOpen={() => setOpen(true)}
        openLabel={
          <>
            <Maximize2 aria-hidden="true" className="size-3" />
            Open full text
          </>
        }
        toggleClassName={TEXT_ACTION_CLASS}
        actions={actions}
      />
      <MarkdownViewerDialog
        open={open}
        title={title}
        value={text}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
