import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';
import { settingsPatchSchema } from './ipc-schemas';

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
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ...DEFAULT_SETTINGS };
    }
    // Salvage per key. The strict schema keeps renderer WRITES honest (ipc.ts
    // validates every patch), but the on-disk file can be newer than this
    // build — the notify-only brew flow makes version skew normal — so one
    // unknown or invalid key must cost only that key. A wholesale reset would
    // re-onboard the user, and the next updateSettings() write would make the
    // loss permanent. Merging over defaults also completes a file written by
    // an older version as the schema grows.
    const record = raw as Record<string, unknown>;
    const settings: Settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(settingsPatchSchema.shape)) {
      if (!(key in record)) {
        continue;
      }
      const field = settingsPatchSchema.shape[
        key as keyof typeof settingsPatchSchema.shape
      ].safeParse(record[key]);
      if (field.success && field.data !== undefined) {
        (settings as unknown as Record<string, unknown>)[key] = field.data;
      }
    }
    return settings;
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
