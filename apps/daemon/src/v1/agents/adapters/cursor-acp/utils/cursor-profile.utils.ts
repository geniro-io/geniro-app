import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CURSOR_HOME_DIR_NAME,
  CURSOR_PROFILE_DIR_PREFIX,
  CURSOR_SEEDED_CONFIG_FILE,
} from '../cursor-acp.const';

/**
 * A throwaway `CURSOR_CONFIG_DIR` for ONE turn, seeded from the user's own.
 *
 * **Why a turn needs its own profile at all.** Applying a model or a reasoning
 * effort over ACP is not a per-session call: `setCurrentModelWithParameters`
 * PERSISTS into the config directory's `cli-config.json`. Measured against
 * 2026.08.11-e8db854 — one `session/set_config_option` with a model changed
 * `model`, `selectedModel` and `modelSelectionHistory` in the real
 * `~/.cursor/cli-config.json`. So without this, choosing "Sonnet 5" in a geniro
 * chat silently changes what the user's OWN `cursor-agent` opens with, and a
 * per-chat effort would do the same. That is the one thing this app does not do
 * to a CLI's files (the MCP toggle is a deliberate, documented exception, and it
 * is deliberate precisely because it is the switch the user WANTS shared).
 *
 * **Why a copy of `cli-config.json`, and only that.** The copy is what keeps the
 * turn behaving like the user's own CLI — their `permissions.allow`, their
 * `approvalMode`, their default model, their display settings all come along, so
 * a run that names no model still opens on the model they chose. Nothing else is
 * copied:
 *
 * - `mcp.json` is deliberately NOT copied and NOT symlinked. It is mode 0600 and
 *   holds the user's own server credentials, and duplicating a secret-bearing
 *   file is not something a per-turn temp dir should do. It is also unnecessary,
 *   which is the part that had to be measured rather than hoped: under an
 *   isolated directory holding only `cli-config.json`, an ACP session still
 *   loaded the folder's MCP servers (codegraph / github / playwright visible in
 *   its own tool list) and `cursor-agent mcp list` still reported all eleven.
 *   The CLI resolves that file from the user's home directory either way.
 * - `statsig-cache.json` is left to the CLI to fetch. It writes ~690KB per turn,
 *   which sounded like a latency cost worth avoiding until it was measured: a
 *   handshake under a fresh directory took 5.9s against 6.5–7.7s on the default
 *   profile, so there is nothing to optimise and a shared cache file would only
 *   add a write nobody owns.
 *
 * A missing or unreadable source config is NOT an error: the CLI creates its own
 * defaults, and the turn runs on those rather than failing over a file geniro
 * merely wanted to inherit.
 */
export function seedCursorProfile(baseDir: string, homeDir?: string): string {
  mkdirSync(baseDir, { recursive: true });
  // `mkdtemp` rather than a name built from the run: two turns of one run can be
  // in flight together under graph fan-out, and they must not share a profile —
  // that is the same race, moved one level in.
  const dir = mkdtempSync(join(baseDir, CURSOR_PROFILE_DIR_PREFIX));
  try {
    copyFileSync(
      join(
        homeDir ?? homedir(),
        CURSOR_HOME_DIR_NAME,
        CURSOR_SEEDED_CONFIG_FILE,
      ),
      join(dir, CURSOR_SEEDED_CONFIG_FILE),
    );
  } catch {
    // Absent, unreadable, or a directory — the CLI writes its own defaults.
  }
  return dir;
}

/** Drop one turn's profile. Never throws — a leftover costs disk, not a turn. */
export function removeCursorProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Drop the profiles a previous daemon launch left behind.
 *
 * The disposer runs on every settle path, so this only ever finds directories
 * from a SIGKILLed daemon — where no disposer ran at all. Called once at boot,
 * for the same reason claude sweeps its per-turn MCP configs there.
 */
export function sweepStaleCursorProfiles(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}
