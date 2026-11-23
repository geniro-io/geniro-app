import { useRef, useState } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';

/**
 * The shortest gap between two paths shown from one place: as long as a click
 * stays fresh in Chromium (`navigator.userActivation`, 5 s), so one click opens at
 * most one Finder window.
 */
export const OPEN_PATH_GAP_MS = 5000;

/** The longest path that may be shown, as main's schema bounds it. */
const MAX_OPEN_PATH = 1024;

/** The absolute path an agent named, or null when it names none. */
export function pathToOpen(path: unknown): string | null {
  return typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= MAX_OPEN_PATH &&
    !path.includes('\u0000')
    ? path
    : null;
}

/** Whether the user's click (or key) that this action follows is still fresh. */
function userJustActed(): boolean {
  return (
    (navigator as { userActivation?: { isActive: boolean } }).userActivation
      ?.isActive === true
  );
}

export interface ShowInFinder {
  /** Show the path in Finder, only on a fresh click and once per {@link OPEN_PATH_GAP_MS}. */
  show: (path: string) => void;
  /** Why the last path could not be shown, or null. */
  failure: string | null;
  clearFailure: () => void;
}

/** Shows a path an agent named in Finder through main, which opens nothing it could launch. */
export function useShowInFinder(): ShowInFinder {
  const lastShownAt = useRef(0);
  const [failure, setFailure] = useState<string | null>(null);

  const show = useLatestCallback((path: string): void => {
    const now = Date.now();
    if (!userJustActed() || now - lastShownAt.current < OPEN_PATH_GAP_MS) {
      return;
    }
    lastShownAt.current = now;
    setFailure(null);
    window.geniro
      .showInFinder(path)
      .then((outcome) => {
        setFailure(outcome.shown === null ? outcome.reason : null);
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const clearFailure = useLatestCallback((): void => setFailure(null), []);

  return { show, failure, clearFailure };
}
