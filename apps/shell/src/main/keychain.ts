import { Entry } from '@napi-rs/keyring';

import { KEYCHAIN_SERVICE, type SecretName } from '../shared/contracts';

/**
 * Secret storage backed by the macOS Keychain (true Keychain items, via the
 * N-API `@napi-rs/keyring`). Secrets are NEVER written to disk or SQLite — the
 * forbidden_action "Keychain only" holds. The standalone daemon can read the
 * same items directly when it spawns agents (M2), since these are real Keychain
 * entries rather than an Electron-bound encrypted blob.
 */
function entry(name: SecretName): Entry {
  return new Entry(KEYCHAIN_SERVICE, name);
}

export function saveSecret(name: SecretName, value: string): void {
  entry(name).setPassword(value);
}

export function getSecret(name: SecretName): string | null {
  try {
    return entry(name).getPassword();
  } catch {
    // keyring throws when the item is absent.
    return null;
  }
}

export function hasSecret(name: SecretName): boolean {
  return getSecret(name) !== null;
}

export function deleteSecret(name: SecretName): void {
  try {
    entry(name).deletePassword();
  } catch {
    // deleting a missing item is a no-op for us.
  }
}
