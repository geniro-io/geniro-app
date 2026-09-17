import { useEffect } from 'react';

/**
 * ⌃` toggles the terminal panel, as it does in VS Code.
 *
 * In the CAPTURE phase and stopped there: inside a focused terminal the emulator
 * would otherwise take the chord first and send the shell a NUL.
 */
export function useTerminalShortcut(onToggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === 'Backquote'
      ) {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onToggle]);
}
