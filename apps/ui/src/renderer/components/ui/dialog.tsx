import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

/**
 * A minimal modal dialog: a dark backdrop + a centered token-styled card.
 * Closes on Escape, backdrop click, or the corner ✕. Not a full focus-trap
 * dialog (no dep) — enough for read-only detail popups like the palette's
 * agent info.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element | null {
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/30" aria-hidden="true" />
      <div
        className={cn(
          'relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-panel-md',
          className,
        )}
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <div className="text-sm font-semibold">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
