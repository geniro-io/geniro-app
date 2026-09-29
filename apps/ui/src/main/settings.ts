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
import { AGENT_DESCRIPTORS } from './agents/agent-descriptors';
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

/**
 * The file's top-level object, or `null` when it is not one. ONE predicate for
 * both sides of the file: what the read falls back to defaults over is exactly
 * what the write preserves before replacing, so neither can come to call a
 * file readable that the other would discard.
 */
function parseSettingsObject(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = parseSettingsObject(readFileSync(path, 'utf8'));
    if (parsed === null) {
      return { ...DEFAULT_SETTINGS };
    }
    // Salvage per key. The strict schema keeps renderer WRITES honest (ipc.ts
    // validates every patch), but the on-disk file can be newer than this
    // build — the notify-only brew flow makes version skew normal — so one
    // unknown or invalid key must cost only that key. A wholesale reset would
    // re-onboard the user, and the next updateSettings() write would make the
    // loss permanent. Merging over defaults also completes a file written by
    // an older version as the schema grows.
    const record = scopeUnscopedConfigDirs(parsed);
    const salvaged: Record<string, unknown> = {};
    for (const key of Object.keys(settingsPatchSchema.shape)) {
      if (!(key in record)) {
        continue;
      }
      if (
        key === 'cliPaths' ||
        key === 'configDirs' ||
        key === 'recentConfigDirs' ||
        key === 'agentOptions'
      ) {
        const entries = salvageCliRecord(key, record[key]);
        if (entries !== undefined) {
          salvaged[key] = entries;
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
 * A file written while the app remembered ONE config directory for every agent
 * holds `configDir` as a string, `recentConfigDirs` as a flat list and profiles
 * with no `agent`. Every one of them belongs to the CLI whose descriptor
 * declares `ownsUnscopedConfigDirs` — no other CLI could run under a config
 * directory then — so they are filed under it here, and the next write stores
 * the per-CLI shape. Without this the per-key salvage would drop all three,
 * and the named profiles are hand-made and unrecoverable.
 */
function scopeUnscopedConfigDirs(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const owner = Object.values(AGENT_DESCRIPTORS).find(
    (descriptor) => descriptor.ownsUnscopedConfigDirs,
  )?.kind;
  if (owner === undefined) {
    return record;
  }
  const scoped = { ...record };
  if (typeof record.configDir === 'string' && !('configDirs' in record)) {
    scoped.configDirs = { [owner]: record.configDir };
  }
  if (Array.isArray(record.recentConfigDirs)) {
    scoped.recentConfigDirs = { [owner]: record.recentConfigDirs };
  }
  if (Array.isArray(record.configProfiles)) {
    scoped.configProfiles = record.configProfiles.map((profile: unknown) =>
      typeof profile === 'object' &&
      profile !== null &&
      !Array.isArray(profile) &&
      !('agent' in profile)
        ? { ...profile, agent: owner }
        : profile,
    );
  }
  return scoped;
}

/**
 * The per-CLI records are nested, and zod rejects a record WHOLESALE on a
 * single unknown key or invalid value — exactly the blast radius the per-key
 * salvage exists to avoid (a newer build's extra agent kind would wipe the
 * user's still-valid binary paths). Salvage each entry by entry through the
 * same schema, so each bad entry costs only itself.
 */
function salvageCliRecord<
  K extends 'cliPaths' | 'configDirs' | 'recentConfigDirs' | 'agentOptions',
>(key: K, value: unknown): Settings[K] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const salvaged: Record<string, unknown> = {};
  for (const [kind, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const single = settingsPatchSchema.shape[key].safeParse({ [kind]: entry });
    if (single.success && single.data) {
      Object.assign(salvaged, single.data);
    }
  }
  return salvaged as Settings[K];
}

/**
 * Same per-entry salvage as {@link salvageCliPaths}, for the three HAND-MANAGED
 * lists — the saved run configurations, the fast actions, and the named agent
 * configurations. Zod rejects an ARRAY wholesale on one bad element, and the
 * blast radius here is the user's whole set of them, each hand-written and
 * unrecoverable. Order is preserved: it is the order the user arranged, not an
 * MRU this file is free to re-sort.
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

/**
 * Copies a settings.json that does not parse as an object to
 * `settings.json.corrupt-<timestamp>` beside it, before a write replaces it.
 *
 * The read answers such a file with DEFAULTS, so the first write after it —
 * `{...readSettings(), ...patch}` — is defaults plus one field, renamed over
 * the only copy of the user's run configurations, fast actions, named
 * profiles and custom instructions. Those are hand-written and nothing else
 * holds them. A file this build cannot parse may still be one a person (or a
 * newer build) can, so its bytes are kept verbatim.
 *
 * Here rather than at the read, because reads are frequent and a backup per
 * read would pile up; the write is the moment the loss would become
 * permanent, and after it the file parses, so this fires once per corruption.
 * A parseable file is never copied. One that cannot even be READ throws, and
 * the write with it: replacing bytes nobody could look at is the loss this
 * exists to prevent.
 */
function preserveUnparseableSettings(path: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (parseSettingsObject(bytes.toString('utf8')) !== null) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 0600 at CREATION (and `wx`, never over an existing file), as the device
  // registry writes: this may be the user's only copy of what it holds.
  writeFileSync(`${path}.corrupt-${stamp}`, bytes, {
    mode: 0o600,
    flag: 'wx',
  });
}

export function writeSettings(next: Settings): Settings {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  preserveUnparseableSettings(path);
  renameSync(tmp, path);
  return next;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return writeSettings({ ...readSettings(), ...patch });
}
