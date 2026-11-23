import type { CliDetection } from '../shared/contracts';

export function signedOutConfigurations(detection: CliDetection): number {
  return Object.values(detection.profileLogins ?? {}).filter(
    (login) => login === false,
  ).length;
}

export function signedOutAccounts(detection: CliDetection): number {
  if (!detection.found) {
    return 0;
  }
  return (
    (detection.loggedIn === false ? 1 : 0) + signedOutConfigurations(detection)
  );
}
