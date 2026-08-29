import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

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
  const [value, setValue] = useState(() => {
    // An ABSENT key is the only thing that means "never chosen" — `'0'` is a
    // choice, and reading it as falsy-so-default would make "collapsed" the one
    // state the app could not remember when the default is open.
    const stored = localStorage.getItem(storageKey);
    return stored === null ? fallback : stored === '1';
  });

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
  }, [storageKey, value]);

  return [value, setValue];
}
