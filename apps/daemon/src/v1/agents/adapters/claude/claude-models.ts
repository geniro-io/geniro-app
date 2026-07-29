import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentModel } from '../adapter.types';

/**
 * The aliases `claude --model` documents: each resolves to the latest model of
 * its tier, so they stay correct across releases without an app update. This
 * is the floor of the list, never the whole of it.
 */
export const CLAUDE_BUILTIN_MODELS: AgentModel[] = [
  { id: 'opus', label: 'opus', source: 'builtin' },
  { id: 'sonnet', label: 'sonnet', source: 'builtin' },
  { id: 'haiku', label: 'haiku', source: 'builtin' },
];

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
    parsed = JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const cached = (parsed as { additionalModelOptionsCache?: unknown })
    .additionalModelOptionsCache;
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
      },
    ];
  });
}

/** The documented aliases plus whatever the CLI has cached, first-wins by id. */
export function claudeModels(homeDir?: string): AgentModel[] {
  const models = [...readClaudeModelCache(homeDir), ...CLAUDE_BUILTIN_MODELS];
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}
