import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * Everyone currently reading a given key, so a write reaches all of them.
 *
 * One key is ONE value, and it is read in more than one place: the shelf above
 * the composer opens the panel's fold, and the panel is a different component
 * subtree. Without this a write would move localStorage and leave the other
 * reader rendering the value it had on mount — the fold would open only after
 * the next remount, which reads as the button doing nothing.
 */
const readers = new Map<string, Set<() => void>>();

function announce(storageKey: string): void {
  for (const notify of readers.get(storageKey) ?? []) {
    notify();
  }
}

function readFlag(storageKey: string, fallback: boolean): boolean {
  // An ABSENT key is the only thing that means "never chosen" — `'0'` is a
  // choice, and reading it as falsy-so-default would make "collapsed" the one
  // state the app could not remember when the default is open.
  const stored = localStorage.getItem(storageKey);
  return stored === null ? fallback : stored === '1';
}

/**
 * Set one of these flags from OUTSIDE the component that renders it.
 *
 * The one caller shape this exists for: a control that reveals something it
 * does not itself draw. It writes through the same key and wakes every reader,
 * so the surface it revealed is open by the time the user looks at it.
 */
export function setPersistedFlag(storageKey: string, value: boolean): void {
  localStorage.setItem(storageKey, value ? '1' : '0');
  announce(storageKey);
}

/**
 * A boolean the user SET and expects to find again — a panel folded shut, a
 * section left open — kept in localStorage under `storageKey`.
 *
 * Component state alone cannot hold these: the builder unmounts on every nav
 * change, and the agents panel is remounted per run on purpose (see its `key`
 * in `Chats.tsx`), so a fold would come undone on the next chat the user opened.
 *
 * It reads like `useState`, updater form included, because that is what the
 * call sites were already written against. localStorage rather than
 * `settings.json`: these belong to the window's layout, next to the widths
 * `usePanelWidth` already keeps there, and none of them is worth an IPC
 * round-trip on mount.
 */
export function usePersistedFlag(
  storageKey: string,
  fallback: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => readFlag(storageKey, fallback));

  // Only a CHANGE is written. Writing on mount too would store the fallback
  // under the key the moment the panel first rendered — turning "never chosen"
  // into a choice nobody made, and making every later change of a fallback a
  // no-op for everyone who had already opened that panel once.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    localStorage.setItem(storageKey, value ? '1' : '0');
    announce(storageKey);
  }, [storageKey, value]);

  // Re-reading rather than taking the announced value keeps this one line for
  // both writers, and a re-read that matches is a no-op React bails out of —
  // which is what stops the announcement a write of our own made from looping.
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const notify = (): void =>
      setValue(readFlag(storageKey, fallbackRef.current));
    const group = readers.get(storageKey) ?? new Set<() => void>();
    group.add(notify);
    readers.set(storageKey, group);
    return () => {
      group.delete(notify);
      if (group.size === 0) {
        readers.delete(storageKey);
      }
    };
  }, [storageKey]);

  return [value, setValue];
}
