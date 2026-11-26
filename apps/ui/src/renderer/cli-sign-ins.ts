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

/** Every account an installed CLI said is signed out: its default, then each named configuration. */
export function signedOutAccountRows(
  detection: CliDetection,
): SignedOutAccount[] {
  if (!detection.found) {
    return [];
  }
  const rows: SignedOutAccount[] =
    detection.loggedIn === false
      ? [{ kind: detection.kind, configDir: null }]
      : [];
  for (const [configDir, loggedIn] of Object.entries(
    detection.profileLogins ?? {},
  )) {
    if (loggedIn === false) {
      rows.push({ kind: detection.kind, configDir });
    }
  }
  return rows;
}

export function signedOutAccounts(detection: CliDetection): number {
  return signedOutAccountRows(detection).length;
}
