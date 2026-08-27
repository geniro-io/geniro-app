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
 * account the turn runs under — the variable geniro exported is overwritten.
 *
 * IT LANDS LATE, and that is the part worth carrying, because leaving it out
 * is what got this reverted once and re-argued twice. Measured 2026-08-28 on
 * 2.1.247, `CLAUDE_CONFIG_DIR` naming a personal `max` profile for the whole
 * run, asking `get_usage` every 12s for two minutes:
 *
 * | cwd | +4s … +25s | +37s onward |
 * | --- | --- | --- |
 * | a folder pinning the team profile | `max`, weekly 1% | `team`, weekly 100% |
 * | an unpinned folder | `max`, weekly 1% | `max`, weekly 1% (never moves) |
 *
 * Only the cwd differs. So a one-shot probe answers `max` and reads as proof
 * that the pin does nothing — the trap this block exists to spring.
 *
 * What it does NOT decide is anything resolved at STARTUP, ahead of the
 * settings file: the MCP set follows the environment geniro exports (from one
 * pinned folder, `<A>` loaded A's 17 servers, `<B>` B's 51, and no variable
 * the default's 12). Two questions, two answers — see `effectiveConfigDir` and
 * `accountConfigDir` in the renderer's `chats/run-profile.ts`, which are two
 * functions for exactly this reason.
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
