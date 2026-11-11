import { useEffect, useSyncExternalStore } from 'react';

/**
 * The in-app browser's tabs are native views drawn above the whole page, so an
 * open dialog, menu or popover would sit under one. Every overlay reports
 * itself here while it is open and the browser pane hides its view meanwhile.
 *
 * A module store rather than a provider: the overlay primitives are used
 * everywhere, a portal or a second root would miss a provider, and outside a
 * chat nothing listens and nothing changes.
 */
let openOverlays = 0;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Count an overlay that is not a component (a drag in progress); call the answer to end it. */
export function holdOverlay(): () => void {
  openOverlays += 1;
  announce();
  let released = false;
  return () => {
    if (!released) {
      released = true;
      openOverlays -= 1;
      announce();
    }
  };
}

/** Count this overlay as covering the page for as long as `open` holds. */
export function useReportOverlayOpen(open: boolean): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    openOverlays += 1;
    announce();
    return () => {
      openOverlays -= 1;
      announce();
    };
  }, [open]);
}

/** True while any dialog, menu or popover is open. */
export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openOverlays > 0,
    () => false,
  );
}
