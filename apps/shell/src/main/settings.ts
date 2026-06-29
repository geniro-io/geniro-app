import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_SETTINGS, type Settings } from '@packages/types';
import { app } from 'electron';

/**
 * Non-secret app settings, persisted as a plain JSON file in Electron's
 * userData dir. We hand-roll this (atomic temp+rename writes) instead of
 * pulling in electron-store, whose current major is ESM-only and breaks
 * `require` from the CommonJS main process. Secrets never live here — see
 * keychain.ts.
 */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    // Merge over defaults so a settings file written by an older version still
    // yields a complete object as the schema grows.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(next: Settings): Settings {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, path);
  return next;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return writeSettings({ ...readSettings(), ...patch });
}
