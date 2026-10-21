import { useGlobalChord } from '../components/use-global-chord';

const isNextWaitingChord = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey &&
  event.code === 'KeyJ';

/** ⌘J goes to the next thread waiting on the user (`nextWaiting`), from any view. */
export function useNextWaitingShortcut(onJump: () => void): void {
  useGlobalChord(isNextWaitingChord, onJump);
}
