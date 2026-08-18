import { useCallback, useEffect, useRef, useState } from 'react';

import type { UpdateState } from '../../shared/contracts';

/**
 * The renderer half of the update module.
 *
 * Main owns the state — it is the only process that can read the release feed
 * or write the bundle — and pushes it here on every change. This hook does not
 * poll and holds no rules of its own: a screen showing "downloading 62%" is
 * showing main's own reading, so the banner and Settings cannot report two
 * different things about one download.
 */
export interface UpdateController {
  /** Null until main's first answer arrives — screens render nothing for it. */
  state: UpdateState | null;
  /** Ask the release feed now (the Settings button). */
  check: () => Promise<void>;
  /** Download, verify and swap in the available update. Does NOT restart. */
  install: () => Promise<void>;
  /** Restart into an update that has finished installing (`ready`). */
  relaunch: () => Promise<void>;
}

export function useUpdateState(): UpdateController {
  const [state, setState] = useState<UpdateState | null>(null);
  /**
   * Whether a PUSHED state has already landed.
   *
   * The initial fetch and the subscription race: a check that finishes while
   * the initial `getUpdateState` is still in flight would otherwise be
   * overwritten by the older snapshot it resolves with, leaving the screen on
   * `idle` until something else changed.
   */
  const pushed = useRef(false);

  useEffect(() => {
    const unsubscribe = window.geniro.onUpdateState((next) => {
      pushed.current = true;
      setState(next);
    });
    void window.geniro.getUpdateState().then((initial) => {
      if (!pushed.current) {
        setState(initial);
      }
    });
    return unsubscribe;
  }, []);

  /**
   * Run one of main's update calls and adopt the state it resolves with.
   *
   * The service answers a failed check or a failed install with an `error`
   * STATE rather than a rejection, so the catch here is for the channel itself
   * — a window torn down mid-call, a handler that threw before the service was
   * reached. Without it that surfaces as an unhandled rejection and a button
   * that visibly does nothing.
   */
  const run = useCallback(
    async (call: () => Promise<UpdateState>): Promise<void> => {
      try {
        setState(await call());
      } catch (err) {
        setState((prev) => ({
          version: null,
          currentVersion: '',
          canInstall: false,
          ...prev,
          phase: 'error',
          progress: null,
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [],
  );

  const check = useCallback(
    () => run(() => window.geniro.checkForUpdates()),
    [run],
  );

  const install = useCallback(
    () => run(() => window.geniro.installUpdate()),
    [run],
  );

  const relaunch = useCallback(
    () => run(() => window.geniro.relaunchForUpdate()),
    [run],
  );

  return { state, check, install, relaunch };
}
