import { useEffect, useRef, useState } from 'react';

import { useLatestCallback } from './use-latest-callback';

/** How long a control's ✓ or ✗ acknowledgement stays before it reverts. */
export const FLASH_WINDOW_MS = 1500;

/**
 * A brief acknowledgement a control shows after it acted — a copy's ✓, a
 * refresh's ✓ or ✗ — reverting on its own after {@link FLASH_WINDOW_MS}.
 * Showing again restarts the window, and a `show` after unmount is dropped.
 */
export function useFlash<Kind extends string>(): {
  flash: Kind | null;
  show: (kind: Kind) => void;
} {
  const [flash, setFlash] = useState<Kind | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);
  const show = useLatestCallback((kind: Kind) => {
    if (!mounted.current) {
      return;
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    setFlash(kind);
    timer.current = setTimeout(() => {
      timer.current = null;
      setFlash(null);
    }, FLASH_WINDOW_MS);
  }, []);
  return { flash, show };
}
