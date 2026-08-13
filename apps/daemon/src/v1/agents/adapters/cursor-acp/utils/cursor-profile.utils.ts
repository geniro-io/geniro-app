import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_HOME_DIR_NAME,
  CURSOR_PROFILE_DIR_PREFIX,
  CURSOR_SEEDED_CONFIG_FILE,
} from '../cursor-acp.const';

/** What one turn's throwaway profile is built from. */
export interface CursorProfileSeed {
  /** Directory the throwaway profiles are created in. */
  baseDir: string;
  /**
   * Where the CLI's `acp-sessions` conversation store should really live, linked
   * into the profile under that name.
   *
   * Omitted for a profile whose sessions must die with it — a `listModels`
   * handshake opens a real session, and those belong nowhere the next turn can
   * find them. A CHAT turn always names one, or its thread cannot be resumed.
   */
  sessionStoreDir?: string;
  /** The user's home, for reading their `cli-config.json` (test seam). */
  homeDir?: string;
}

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
 *
 * **What must NOT be per turn, and the bug that taught it.** The CLI keeps each
 * ACP conversation at `<configDir>/acp-sessions/<sessionId>/` — inside the very
 * directory this removes on settle. So the first shipped version of this deleted
 * every thread as it created it, and a cursor chat's SECOND message died on
 * `-32602 Invalid params {"message":"Session \"…\" not found"}` with no reply
 * written: the turn failed at `session/load`, before the prompt. Measured on
 * 2026.08.11-e8db854, both directions — a load under the profile that created the
 * session succeeds, the same load under a second empty profile does not.
 *
 * So that ONE name is a symlink to a store shared by every turn, and everything
 * this isolation exists for stays per turn. Also measured, because the scheme
 * rests on it: the CLI writes THROUGH the link (the session store appeared in the
 * shared target, not in the profile), a second throwaway profile carrying the
 * same link resumed the session and answered a codeword only turn 1 was told,
 * `node:fs` `rm -r` of the profile unlinks the symlink and leaves the target
 * intact, and the user's own `cli-config.json` stayed byte-identical across a
 * turn that applied a model.
 */
export function seedCursorProfile(seed: CursorProfileSeed): string {
  mkdirSync(seed.baseDir, { recursive: true });
  // `mkdtemp` rather than a name built from the run: two turns of one run can be
  // in flight together under graph fan-out, and they must not share a profile —
  // that is the same race, moved one level in.
  const dir = mkdtempSync(join(seed.baseDir, CURSOR_PROFILE_DIR_PREFIX));
  try {
    copyFileSync(
      join(
        seed.homeDir ?? homedir(),
        CURSOR_HOME_DIR_NAME,
        CURSOR_SEEDED_CONFIG_FILE,
      ),
      join(dir, CURSOR_SEEDED_CONFIG_FILE),
    );
  } catch {
    // Absent, unreadable, or a directory — the CLI writes its own defaults.
  }
  if (seed.sessionStoreDir !== undefined) {
    // Deliberately NOT swallowed, unlike the config copy above. A missing config
    // costs the user's settings for one turn; a missing link costs the THREAD,
    // silently, and the turn that discovers it is the one that cannot resume.
    // Every way this can fail (an unwritable userData dir) is one where the
    // daemon has already stopped working, so failing the turn here says so.
    mkdirSync(seed.sessionStoreDir, { recursive: true });
    symlinkSync(seed.sessionStoreDir, join(dir, CURSOR_ACP_SESSIONS_DIR_NAME));
  }
  return dir;
}

/**
 * Drop one turn's profile. Never throws — a leftover costs disk, not a turn.
 *
 * Takes the `acp-sessions` SYMLINK with it and not the store behind it:
 * `node:fs` removes a directory tree by `lstat`, so a link is unlinked rather
 * than descended into. Measured, because the whole scheme rests on it — the
 * shared store survived removal of two profiles pointing at it.
 */
export function removeCursorProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Drop the profiles a previous daemon launch left behind.
 *
 * The disposer runs on every settle path, so this only ever finds directories
 * from a SIGKILLed daemon — where no disposer ran at all. Called once at boot,
 * for the same reason claude sweeps its per-turn MCP configs there.
 *
 * `baseDir` is the profile base and NEVER the conversation store, which is why
 * the two live in separate directories: this removes the base wholesale, so a
 * store nested inside it would be deleted on every launch — every cursor thread
 * unresumable after a restart, which is the same failure the per-turn profile
 * caused, moved to boot.
 */
export function sweepStaleCursorProfiles(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}
