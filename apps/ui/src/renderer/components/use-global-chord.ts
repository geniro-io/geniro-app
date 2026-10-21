import { useEffect } from 'react';

/**
 * An app-wide keyboard chord: `onFire` runs when `matches` accepts a keydown
 * anywhere in the window.
 *
 * In the CAPTURE phase and stopped there, so a focused editor or the terminal
 * emulator never sees the chord (inside a terminal it would otherwise reach the
 * shell). Skipped while a name is being typed in place, where acting on the
 * chord would take the field with it and save the half-typed name on its way
 * out — and inside a modal dialog, which traps focus and would be left over a
 * screen that changed beneath it.
 */
export function useGlobalChord(
  matches: (event: KeyboardEvent) => boolean,
  onFire: () => void,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        !(
          event.target instanceof Element &&
          event.target.closest(
            '[data-slot="inline-rename"], [role="dialog"][aria-modal="true"]',
          )
        ) &&
        matches(event)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onFire();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [matches, onFire]);
}
