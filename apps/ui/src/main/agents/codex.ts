import { join } from 'node:path';

import { type CliAgentDescriptor, parseJsonObject } from './agent-descriptor';

/**
 * codex's OWN ordering, mirrored from codex-rs `update_versions.rs`: the first
 * three dot-separated parts, each a whole number, compared as a tuple; anything
 * else (a pre-release like `0.11.0-beta.1`) is null, exactly as `is_newer`
 * answers `None`. Mirrored rather than invented, so this app cannot offer an
 * update codex itself would not.
 */
function codexIsNewer(latest: string, current: string): boolean | null {
  const parse = (version: string): number[] | null => {
    const parts = version.trim().split('.').slice(0, 3);
    return parts.length === 3 && parts.every((part) => /^\d+$/.test(part))
      ? parts.map(Number)
      : null;
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) {
    return null;
  }
  const at = l.findIndex((part, i) => part !== c[i]);
  return at !== -1 && (l[at] ?? 0) > (c[at] ?? 0);
}

/** What the main process knows about `codex` (OpenAI Codex CLI). */
export const CODEX_DESCRIPTOR: CliAgentDescriptor = {
  kind: 'codex',
  // Read out of the 0.157.1 binary's own string table: the three credentials
  // it authenticates with, its config home (which account a run is) and its
  // state directory. A GitHub token it uses for its cloud tasks rides along,
  // since it is a credential all the same.
  ownEnvKeys: [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
  ],
  // `codex login status` offers no structured form, so its two answers are
  // read by exit code AND wording, each of which must agree: measured on
  // 0.157.1, `Logged in using ChatGPT` exits 0 and `Not logged in` (under an
  // empty CODEX_HOME) exits 1 — both on STDERR, with stdout empty. Anything
  // else is not an answer.
  //
  // The account lives INSIDE the config home, so a named configuration is probed
  // by pointing the CLI at it (measured on 0.157.1: under an empty `CODEX_HOME`
  // it answers `Not logged in`, exit 1, while the default profile answers
  // `Logged in using ChatGPT`; a home that does not exist is an error, which
  // reads as unknown rather than as signed out).
  loginProbe: {
    args: ['login', 'status'],
    configDirEnv: 'CODEX_HOME',
    read: ({ stderr, exitCode }) => {
      const text = stderr.trim().toLowerCase();
      if (exitCode === 0 && text.startsWith('logged in')) {
        return true;
      }
      if (exitCode !== 0 && text.startsWith('not logged in')) {
        return false;
      }
      return null;
    },
  },
  // `codex update` updates in one step and offers no check-only flag — but the
  // interactive codex checks on startup (`check_for_update_on_startup`, on by
  // default) and records the answer in `$CODEX_HOME/version.json`:
  // `{latest_version, last_checked_at, dismissed_version}` (codex-rs
  // `updates_cache.rs`; measured on 0.157.1). Read off disk, so geniro asks no
  // server — codex did. `app-server`, which geniro runs, never writes it, so a
  // user who never opens the interactive codex has no record.
  latestProbe: {
    recordPath: (configHome, env, userHome) =>
      join(
        configHome ?? env.CODEX_HOME ?? join(userHome, '.codex'),
        'version.json',
      ),
    read: (record, installedVersion) => {
      const row = parseJsonObject(record);
      const latest = row?.['latest_version'];
      const checkedAt = Date.parse(String(row?.['last_checked_at']));
      if (typeof latest !== 'string' || Number.isNaN(checkedAt)) {
        return null;
      }
      // `--version` answers `codex-cli 0.157.1`; codex compares the bare number.
      const installed = installedVersion.trim().split(/\s+/).pop() ?? '';
      return {
        available: codexIsNewer(latest, installed),
        latestVersion: latest,
        checkedAt,
      };
    },
    // codex re-checks once its record is older than 20 hours (`updates.rs`).
    freshForMs: 20 * 60 * 60 * 1000,
    unansweredReason:
      'codex checks for a new version when its interactive session starts — run `codex` in a terminal to check again.',
  },
  updateArgs: ['update'],
  // The standalone build (read 2026-10-09), the route codex's own README leads
  // with: no node, binary to `~/.local/bin/codex`, checksum-verified. It adds
  // `~/.local/bin` to the shell profile itself, then asks `Start Codex now?
  // [y/N]` — `CODEX_NON_INTERACTIVE` is its own switch for skipping that.
  installer: {
    url: 'https://chatgpt.com/codex/install.sh',
    shell: '/bin/sh',
    env: { CODEX_NON_INTERACTIVE: '1' },
  },
};
