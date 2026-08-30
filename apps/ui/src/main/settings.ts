import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import {
  DEFAULT_SETTINGS,
  MAX_CONFIG_PROFILES,
  MAX_FAST_ACTIONS,
  MAX_RUN_CONFIGS,
  type Settings,
} from '../shared/contracts';
import { settingsPatchSchema } from './ipc-schemas';

/**
 * Non-secret app settings, persisted as a plain JSON file in Electron's
 * userData dir. We hand-roll this (atomic temp+rename writes) instead of
 * pulling in electron-store, whose current major is ESM-only and breaks
 * `require` from the CommonJS main process. Secrets never live here — and there
 * are none to live anywhere: see the Secrets section of `shared/contracts.ts`
 * for why the Keychain surface was removed and why the rule still stands.
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
    const salvaged: Record<string, unknown> = {};
    for (const key of Object.keys(settingsPatchSchema.shape)) {
      if (!(key in record)) {
        continue;
      }
      if (key === 'cliPaths') {
        const paths = salvageCliPaths(record[key]);
        if (paths !== undefined) {
          salvaged[key] = paths;
        }
        continue;
      }
      if (key === 'runConfigs') {
        const configs = salvageList('runConfigs', record[key], MAX_RUN_CONFIGS);
        if (configs !== undefined) {
          salvaged[key] = configs;
        }
        continue;
      }
      if (key === 'fastActions') {
        const actions = salvageList(
          'fastActions',
          record[key],
          MAX_FAST_ACTIONS,
        );
        if (actions !== undefined) {
          salvaged[key] = actions;
        }
        continue;
      }
      if (key === 'configProfiles') {
        const profiles = salvageList(
          'configProfiles',
          record[key],
          MAX_CONFIG_PROFILES,
        );
        if (profiles !== undefined) {
          salvaged[key] = profiles;
        }
        continue;
      }
      const field = settingsPatchSchema.shape[
        key as keyof typeof settingsPatchSchema.shape
      ].safeParse(record[key]);
      if (field.success && field.data !== undefined) {
        salvaged[key] = field.data;
      }
    }
    return { ...DEFAULT_SETTINGS, ...salvaged } as Settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * cliPaths is the schema's one nested record, and zod rejects a record
 * WHOLESALE on a single unknown key or invalid value — exactly the blast
 * radius the per-key salvage exists to avoid (a newer build's extra agent
 * kind would wipe the user's still-valid binary paths). Salvage it entry by
 * entry through the same schema, so each bad entry costs only itself.
 */
function salvageCliPaths(value: unknown): Settings['cliPaths'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const salvaged: Settings['cliPaths'] = {};
  for (const [kind, path] of Object.entries(value as Record<string, unknown>)) {
    const single = settingsPatchSchema.shape.cliPaths.safeParse({
      [kind]: path,
    });
    if (single.success && single.data) {
      Object.assign(salvaged, single.data);
    }
  }
  return salvaged;
}

/**
 * Same per-entry salvage as {@link salvageCliPaths}, for the three HAND-MANAGED
 * lists — the saved run configurations, the fast actions, and the named agent
 * configurations. Zod rejects an
 * ARRAY wholesale on one bad element, and the blast radius here is the user's
 * whole set of them, each hand-written and unrecoverable. Order is preserved:
 * it is the order the user arranged, not an MRU this file is free to re-sort.
 *
 * ONE function over all three rather than a copy each. They are different
 * features and must never be folded together in the UI — but this rule is about
 * the FILE, not the feature: entry-by-entry, unique ids, re-apply the cap. A
 * second copy is how one list would quietly acquire a fix the other lacks.
 */
function salvageList<K extends 'runConfigs' | 'fastActions' | 'configProfiles'>(
  key: K,
  value: unknown,
  cap: number,
): Settings[K] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entry = settingsPatchSchema.shape[key].unwrap().element;
  const salvaged: Settings[K][number][] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = entry.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    // Ids must be UNIQUE, and this is the only place that can guarantee it: the
    // schema cannot express it, and every consumer keys on the id across the
    // whole list, so a duplicate in a hand-edited file makes renaming one entry
    // silently rewrite another, and deleting one remove two.
    if (seen.has(parsed.data.id)) {
      continue;
    }
    seen.add(parsed.data.id);
    salvaged.push(parsed.data as Settings[K][number]);
  }
  // Salvaging entry-by-entry skips the array-level cap, so it is re-applied
  // here: an over-long hand-edited file would otherwise load in full and then
  // make every subsequent write fail its own schema.
  return salvaged.slice(0, cap) as Settings[K];
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
