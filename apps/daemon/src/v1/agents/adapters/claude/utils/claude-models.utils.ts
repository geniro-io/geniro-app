import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentModel } from '../../adapter.types';
import {
  CLAUDE_MODEL_CACHE_FILE,
  CLAUDE_MODEL_CACHE_KEY,
} from '../claude.const';

/**
 * Read the account-specific models claude caches for its own `/model` picker.
 *
 * The CLI has NO list-models subcommand — asking for one is an open feature
 * request (anthropics/claude-code#12612) — so the only live source is the
 * cache the CLI itself writes to `~/.claude.json` after fetching your account's
 * options: `additionalModelOptionsCache: [{ value, label, description }]`. It
 * holds the models BEYOND the tier aliases (Fable, org-specific models), which
 * is exactly what a hardcoded list can never know.
 *
 * That file is internal and unversioned, so every field is checked rather than
 * trusted: a shape change degrades to the built-in aliases instead of throwing
 * or listing junk. Absent/unreadable/not-yet-populated all return [].
 */
export function readClaudeModelCache(homeDir = homedir()): AgentModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(homeDir, CLAUDE_MODEL_CACHE_FILE), 'utf8'),
    );
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const cached = (parsed as Record<string, unknown>)[CLAUDE_MODEL_CACHE_KEY];
  if (!Array.isArray(cached)) {
    return [];
  }
  return cached.flatMap((entry): AgentModel[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const { value, label } = entry as { value?: unknown; label?: unknown };
    if (typeof value !== 'string' || value.length === 0) {
      return [];
    }
    return [
      {
        id: value,
        label: typeof label === 'string' && label ? label : value,
        source: 'cli',
        // Always null for this CLI: effort is its own `--effort` flag, so a
        // model id never carries one. Not read from the cache entry either —
        // the CLI's cached rows are `{value,label}` and inventing a third field
        // would be reporting something it never said.
        effort: null,
      },
    ];
  });
}

/**
 * Whatever the CLI has cached, floored by the documented aliases — first-wins
 * by id.
 *
 * The floor is a PARAMETER, not an import: `config.builtinModels` is the one
 * declared source of a CLI's fallback set, and reaching past config to the raw
 * const here would make that field write-only — a new adapter author would set
 * it and get nothing. The adapter passes `this.getConfig().builtinModels`; staying a
 * pure function keeps the spec able to drive it without an adapter.
 */
export function claudeModels(
  builtinModels: readonly AgentModel[],
  homeDir?: string,
): AgentModel[] {
  const models = [...readClaudeModelCache(homeDir), ...builtinModels];
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}
