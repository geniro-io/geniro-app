import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigDirPin } from '../../adapter.types';
import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_PROJECT_SETTINGS_FILES,
} from '../claude.const';

/**
 * What a FOLDER says this CLI's config directory should be, whatever geniro
 * put in its environment.
 *
 * This CLI reads its per-project settings files and applies their `env` block
 * to its OWN process, so an entry for `CLAUDE_CONFIG_DIR` there decides which
 * account the turn runs under — the variable geniro exported is simply
 * overwritten. Measured 2026-08-27 on 2.1.247 with a folder pinning a second
 * profile: the Bash tool printed the PINNED directory, and `get_usage` answered
 * for the pinned profile's account (`team`, session 100%) while the process's
 * own `CLAUDE_CONFIG_DIR` still named the one geniro chose (a `max` account,
 * session 2%). Both readings taken against the same binary in the same folder,
 * with only the cwd differing from a control that answered correctly.
 *
 * So this is not a preference geniro can win by trying harder — the CLI reads
 * the file after it reads the environment. What it can do is stop claiming the
 * profile it asked for. See {@link ConfigDirPin}.
 *
 * PURE and never throwing, which is what lets a run projection call it: an
 * absent file, unreadable bytes, malformed JSON and an `env` block with no such
 * key are all "nothing is pinned here".
 */
export function readClaudeConfigDirPin(cwd: string): ConfigDirPin | null {
  // LAST wins, matching this CLI's own settings precedence — `settings.json` is
  // the project's shared file and `settings.local.json` the developer's own
  // override of it, which is exactly the file a second account gets pinned in.
  let found: ConfigDirPin | null = null;
  for (const relative of CLAUDE_PROJECT_SETTINGS_FILES) {
    const path = join(cwd, relative);
    const pinned = readPinnedDir(path);
    if (pinned !== null) {
      found = { effective: pinned, source: path };
    }
  }
  return found;
}

/** The `env.CLAUDE_CONFIG_DIR` one settings file sets, or null. */
function readPinnedDir(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const env = (parsed as { env?: unknown }).env;
  if (typeof env !== 'object' || env === null) {
    return null;
  }
  const value = (env as Record<string, unknown>)[CLAUDE_CONFIG_DIR_ENV];
  // A blank string is not a pin. The CLI would read it as an empty value rather
  // than as an absent one, but geniro has nothing to SAY about it — naming an
  // empty directory in the panel explains nothing to anybody.
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
