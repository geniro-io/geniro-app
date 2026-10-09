import { useCallback, useRef, useState } from 'react';

import type {
  CliDetection,
  CliInstallResult,
  CliKind,
} from '../shared/contracts';
import { type CliLoginController, isLoginOver } from './use-cli-login';

/**
 * Whether a finished install should go straight on to signing in — the "and
 * set up" half of the Install press.
 *
 * Only when the fresh binary SAID it is signed out: `null` is a probe that
 * could not tell, and a sign-in started on a guess opens a browser for an
 * account that may already be signed in (a reinstall over an existing login).
 * And never over a sign-in already running — one runs at a time, and a second
 * would take its panel away mid-flow.
 */
export function signInAfterInstall(
  result: CliInstallResult,
  clis: readonly CliDetection[],
  login: Pick<CliLoginController, 'login' | 'starting'>,
): boolean {
  if (!result.ok) {
    return false;
  }
  const busy =
    login.starting !== null ||
    (login.login !== null && !isLoginOver(login.login.session));
  return (
    !busy &&
    clis.find((detection) => detection.kind === result.kind)?.loggedIn === false
  );
}

export interface CliInstallController {
  /** The CLIs whose installer is running right now. */
  installing: ReadonlySet<CliKind>;
  /** What the last finished install of each CLI did. */
  results: Partial<Record<CliKind, CliInstallResult>>;
  install: (kind: CliKind) => Promise<void>;
}

/**
 * Drives the agent cards' Install button — shared by Onboarding and Settings,
 * which draw the same `AgentConfigList` and must install the same way.
 *
 * Several CLIs may install at once (each vendor's script writes only its own
 * files), so the running set is a set rather than the single kind the updater
 * keeps. `onInstalled` fires once per finished install, whatever its outcome:
 * it is where the caller re-detects, and — the "and set up" half of the press —
 * starts the sign-in a freshly installed CLI needs.
 */
export function useCliInstall(
  onInstalled: (result: CliInstallResult) => void | Promise<void>,
): CliInstallController {
  const [installing, setInstalling] = useState<ReadonlySet<CliKind>>(
    () => new Set(),
  );
  const [results, setResults] = useState<
    Partial<Record<CliKind, CliInstallResult>>
  >({});
  // The latest render's handler, so the one that runs minutes after the press
  // sees the screen as it is now — a sign-in started meanwhile included.
  const installedRef = useRef(onInstalled);
  installedRef.current = onInstalled;

  const install = useCallback(async (kind: CliKind): Promise<void> => {
    setInstalling((prev) => new Set(prev).add(kind));
    // A retry clears the failure it is retrying, so the card does not go on
    // saying why the LAST attempt failed under a spinner for this one.
    setResults((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    try {
      // Never rejects — main reports every failure inside the result.
      const result = await window.geniro.installCli(kind);
      setResults((prev) => ({ ...prev, [kind]: result }));
      await installedRef.current(result);
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(kind);
        return next;
      });
    }
  }, []);

  return { installing, results, install };
}
