import type { CliDetection, CliKind } from '../shared/contracts';

export interface SignedOutAccount {
  kind: CliKind;
  /** Null for the CLI's own default account. */
  configDir: string | null;
}

export function signedOutConfigurations(detection: CliDetection): number {
  return Object.values(detection.profileLogins ?? {}).filter(
    (login) => login === false,
  ).length;
}

export interface AccountLogin extends SignedOutAccount {
  /** What the CLI answered for it; null when that is not known. */
  loggedIn: boolean | null;
}

/** Every account of an installed CLI with its sign-in answer: its default, then each named configuration. */
export function accountLogins(detection: CliDetection): AccountLogin[] {
  if (!detection.found) {
    return [];
  }
  return [
    { kind: detection.kind, configDir: null, loggedIn: detection.loggedIn },
    ...Object.entries(detection.profileLogins ?? {}).map(
      ([configDir, loggedIn]) => ({
        kind: detection.kind,
        configDir,
        loggedIn,
      }),
    ),
  ];
}

/** Every account an installed CLI said is signed out: its default, then each named configuration. */
export function signedOutAccountRows(
  detection: CliDetection,
): SignedOutAccount[] {
  return accountLogins(detection)
    .filter(({ loggedIn }) => loggedIn === false)
    .map(({ kind, configDir }) => ({ kind, configDir }));
}

export function signedOutAccounts(detection: CliDetection): number {
  return signedOutAccountRows(detection).length;
}
