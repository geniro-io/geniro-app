import { X } from 'lucide-react';
import * as React from 'react';

import { Button } from './button';
import { MenuAnchorContext } from './menu-anchor';
import { cn } from './utils';

/** What the focus trap treats as tabbable inside the dialog card. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every open dialog, in the order it OPENED — the last one is on top.
 *
 * Escape belongs to exactly one dialog. With a `document` listener per dialog,
 * each would close on every Escape, and the ⤢ editor opened over the New task
 * dialog would take that dialog (and its whole draft) down with it on one
 * key. So there is ONE listener for all of them, and it closes the top entry
 * only.
 *
 * Ordered by OPENING, which is the order a user produces by opening one dialog
 * from inside another. Two dialogs that mount already open in the same commit
 * are ranked child-first (React runs a child's effects before its parent's) —
 * no screen does that, and the one sensible answer for it would need the tree.
 */
const layers: { close: () => void }[] = [];

function closeTopLayer(event: KeyboardEvent): void {
  // A control that owns Escape says so with `preventDefault` — a label field
  // abandoning its draft, a picker closing its menu (`menu.tsx`'s `consume()`).
  // The key was theirs, and closing the dialog around them anyway made their
  // own Escape cost the whole form.
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return;
  }
  const top = layers[layers.length - 1];
  if (top === undefined) {
    return;
  }
  // Consumed here, so nothing else listening on `document` also acts on it.
  event.preventDefault();
  top.close();
}

/** Put a dialog on top of the stack; answers the call that takes it off. */
function pushLayer(layer: { close: () => void }): () => void {
  if (layers.length === 0) {
    document.addEventListener('keydown', closeTopLayer);
  }
  layers.push(layer);
  return () => {
    const index = layers.indexOf(layer);
    if (index !== -1) {
      layers.splice(index, 1);
    }
    if (layers.length === 0) {
      document.removeEventListener('keydown', closeTopLayer);
    }
  };
}

/**
 * A minimal modal dialog: a dark backdrop + a centered token-styled card.
 * Closes on Escape, backdrop click, or the corner ✕. Owns the modal focus
 * contract (no dep): on open, focus moves to the first focusable child after
 * the ✕ (the card itself as fallback), Tab cycles inside the card, and close
 * restores focus to the opener — aria-modal promises assistive tech the
 * background does not exist, so keyboard focus must not walk it either.
 *
 * Escape closes only the dialog on TOP (see `layers`), and never one whose
 * control inside it already handled the key (`preventDefault`).
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  fullScreen = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Fill the window, with no card border, rounded corners or content padding. */
  fullScreen?: boolean;
}): React.JSX.Element | null {
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  // Read through a ref rather than put in the effect's dependencies: callers
  // pass inline arrows, so every render of the screen around an OUTER dialog
  // hands it a new `onClose` — and re-registering on that would move it back
  // to the top of the stack, over the dialog the user actually opened last.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) {
      return;
    }
    return pushLayer({
      close: () => {
        onCloseRef.current();
      },
    });
  }, [open]);

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
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center',
        !fullScreen && 'p-4',
      )}
      onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/30" aria-hidden="true" />
      <div
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          // A flex COLUMN capped at the window, so the header stays put and the
          // body takes exactly the room that is left. It used to be an
          // auto-height card over a body capped at `70vh`, which is a guess
          // about the window rather than a measurement of it: a card whose
          // content wanted more than that got a scrollbar of its own on top of
          // whatever already scrolled inside it — two bars side by side in the
          // session picker — while the space between `70vh` and the real window
          // edge went unused, so the list showed fewer rows than it could.
          'relative z-10 flex max-h-full w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-panel-md outline-none',
          fullScreen && 'h-full max-w-none rounded-none border-0 shadow-none',
          className,
        )}
        onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          {/* `min-w-0` so a long title (an image viewer's file path) can be
              truncated or wrapped by the title node itself — a flex item
              defaults to `min-width: auto`, which refuses to shrink below its
              text and pushes the ✕ off the card instead.

              `flex-1` so the slot is the ROW rather than the width of its own
              text. A title is not always a string: the task panel puts its
              whole header in here — an identifier, Run task, and a run of
              icon-only controls it pushes to the far edge with `ml-auto` —
              and a shrink-to-fit slot leaves that `ml-auto` no free space to
              push into, so every one of them stayed hugging the left with the
              card's whole width empty beside them. REPORTED twice, the second
              time as "buttons still from left". It costs a plain string title
              nothing: text is left-aligned in its box either way, and the ✕
              was already at the edge through `justify-between`. */}
          <div
            data-slot="dialog-title"
            className="min-w-0 flex-1 text-sm font-semibold">
            {title}
          </div>
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
        {/* The body SCROLLS, so it clips: a picker inside it whose panel opens
            past an edge is cut, and `overflow-x: visible` cannot be restored on
            a box that scrolls vertically. Declaring it here is what lets every
            menu inside escape without the dialog's content knowing.

            `min-h-0 flex-1`, so it is the card's cap that decides the height
            and this box simply takes what is left. Content that fits still
            leaves the card its natural size — the body only becomes the
            scroller once the window is genuinely the constraint. A dialog whose
            content wants to manage its own scrolling (the session picker, which
            pins its search field above a scrolling list) makes its ROOT
            `h-full` and puts `overflow-y-auto` on the part that should move;
            this box then has nothing left to scroll and shows no second bar.

            `break-words` because a dialog routinely NAMES something the user
            did not choose the spelling of — a chat title, a folder, a path, an
            error the daemon composed — and any of those can be one unbreakable
            token. Reported against the delete confirm, whose chat title was a
            pasted URL: it ran straight off the card's right edge and was cut,
            so the sentence asking the user to confirm a destructive action was
            unreadable. Wrapping is the only answer that keeps it readable —
            this box already scrolls vertically, which forces the horizontal
            axis non-visible, so an overflowing line is CLIPPED rather than
            reachable. Set here, at the one box every dialog's content sits in,
            because the next long token will be in a different dialog.

            `break-word` rather than `anywhere`: it breaks a word only when the
            word alone cannot fit, so ordinary prose is untouched, and it leaves
            `white-space: pre` content (a code block) to scroll as it should. */}
        <MenuAnchorContext.Provider value="viewport">
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto break-words',
              !fullScreen && 'px-5 py-4',
            )}>
            {children}
          </div>
        </MenuAnchorContext.Provider>
      </div>
    </div>
  );
}
