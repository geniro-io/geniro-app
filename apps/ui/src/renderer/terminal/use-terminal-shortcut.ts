import { useGlobalChord } from '../components/use-global-chord';

const isTerminalChord = (event: KeyboardEvent): boolean =>
  event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  event.code === 'Backquote';

/**
 * ⌃` toggles the terminal panel, as it does in VS Code. Captured before a
 * focused terminal can take it — the emulator would send the shell a NUL.
 */
export function useTerminalShortcut(onToggle: () => void): void {
  useGlobalChord(isTerminalChord, onToggle);
}
