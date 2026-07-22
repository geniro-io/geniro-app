import { X } from 'lucide-react';
import * as React from 'react';

import { Button } from './button';
import { cn } from './utils';

/** What the focus trap treats as tabbable inside the dialog card. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A minimal modal dialog: a dark backdrop + a centered token-styled card.
 * Closes on Escape, backdrop click, or the corner ✕. Owns the modal focus
 * contract (no dep): on open, focus moves to the first focusable child after
 * the ✕ (the card itself as fallback), Tab cycles inside the card, and close
 * restores focus to the opener — aria-modal promises assistive tech the
 * background does not exist, so keyboard focus must not walk it either.
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
  const cardRef = React.useRef<HTMLDivElement | null>(null);

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

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const card = cardRef.current;
    const focusables = [
      ...(card?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []),
    ];
    // Prefer the first focusable AFTER the corner ✕ (a form's input/button);
    // the card itself is the fallback for a content-only popup.
    const initial =
      focusables.find((el) => el.getAttribute('aria-label') !== 'Close') ??
      focusables[0];
    (initial ?? card)?.focus();
    return () => {
      // Restore the opener on close — otherwise focus falls to <body> and a
      // keyboard user restarts from the top of the window.
      opener?.focus();
    };
  }, [open]);

  const trapTab = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const focusables = [
      ...card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ];
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

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
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          'relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-panel-md outline-none',
          className,
        )}
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <div className="text-sm font-semibold">{title}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Close"
            onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
