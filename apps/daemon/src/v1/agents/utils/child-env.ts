/**
 * TWIN PARSER: `apps/ui/src/main/probe-env.ts`.
 *
 * The Electron main process spawns CLI children of its own (`detectClis` runs
 * `--version` and a login `status` on every binary) and shares no code with this
 * app, so it carries its own copy of the same rule. A credential name added to
 * the set below belongs there too, and the reverse — the two are the whole
 * contract, since nothing type-checks across the boundary.
 *
 * Env keys a spawned child must NEVER inherit, beyond the `GENIRO_` prefix:
 *
 * - `CURSOR_API_KEY` — a Cursor credential the USER exported in the shell the
 *   app was launched from. geniro no longer has one of its own to inject: the
 *   Keychain entry, the `GENIRO_CURSOR_API_KEY` hop and the whole secret
 *   surface are gone, and `cursor-agent` authenticates from its own
 *   `~/.cursor` login instead. The strip STAYS regardless, and the reason is
 *   the one below it: an inherited key that reached every child would hand the
 *   user's Cursor credential to the CLAUDE agent, which is the exact
 *   cross-agent leak this set exists to prevent. `CursorAcpAdapter.buildEnv`
 *   re-injects the inherited value for its OWN child only, so a user who
 *   authenticates that way keeps working without the key crossing agents.
 * - `CLAUDE_CODE_SESSION_ID` — present when the APP itself was launched from
 *   inside a Claude Code session (e.g. `pnpm dev` in its terminal). It names
 *   the OUTER session's identity; a spawned agent's conversation is never
 *   that session, so the daemon must not advertise it to children — an agent
 *   or its tools binding to it would cross-wire thread resume and session
 *   capture onto one session file.
 * - `CLAUDE_CONFIG_DIR` — inherited the same way, from a shell that had chosen
 *   a profile for ITSELF. A chat's config directory is part of the run's
 *   identity, picked in the UI and stored on the run row, and the adapter
 *   passes it as `extra` when the run names one. Inheriting it means a chat
 *   that named NONE runs under whatever profile the daemon happened to be
 *   launched with — a different account, and a `--resume` id that is not in
 *   that profile's store. Observed: the app started from a terminal exporting
 *   it ran every default-profile chat under that directory, which is also why
 *   `ClaudeAdapter`'s own "absent, never empty" spec failed on that machine
 *   and passed everywhere else. **The name is declared per adapter as
 *   `AdapterConfig.configDir.envVar` (claude: `CLAUDE_CONFIG_DIR_ENV`), and
 *   spelled again here because the strip must be the UNION over every CLI,
 *   which no single adapter owns. Keep the two in step — a second CLI gaining a
 *   config directory needs its var added to this set.**
 * - {@link CLAUDE_CREDENTIAL_KEYS} — Anthropic credentials inherited when the
 *   app/daemon was launched from a shell that exports them. Stripping them
 *   keeps the cursor→claude and claude→cursor directions symmetric: only the
 *   definitionally-claude spawn paths (the Claude adapter's turns and probes)
 *   re-inject them via {@link claudeCredentialEnv}.
 */
/**
 * Exported so `ClaudeAdapter` can declare it as that CLI's
 * `auth.inheritedEnvKeys` — the same list drives the strip here AND the
 * re-injection there, so the two cannot name different credentials.
 */
export const CLAUDE_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Both are Claude Code's own documented overrides for the SAME thing an API
  // key does, so leaving them off this list broke the symmetry the block above
  // claims: a daemon launched from a shell exporting either handed a working
  // bearer token to `cursor-agent` and to every tool child a turn spawns.
  // `ANTHROPIC_AUTH_TOKEN` becomes an `Authorization: Bearer` header, and
  // `ANTHROPIC_CUSTOM_HEADERS` can carry that same header by hand.
  //
  // This constant drives BOTH the strip below and `claudeCredentialEnv`, so
  // adding a key here keeps the claude path working by construction — that
  // coupling is the reason to add credentials here rather than to
  // `STRIPPED_KEYS` directly.
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;

const STRIPPED_KEYS = new Set([
  'CURSOR_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CONFIG_DIR',
  ...CLAUDE_CREDENTIAL_KEYS,
]);

/**
 * Build a spawned child's environment from the daemon's, stripping every
 * `GENIRO_`-prefixed key plus {@link STRIPPED_KEYS}. `GENIRO_*` carries the
 * daemon's own config and secrets. Stripping means no child (a headless agent
 * CLI, any tool it spawns, or a PTY terminal session) ever inherits another
 * agent's credential, the daemon's internal env, or an outer Claude Code
 * session's identity. Shared by every daemon spawn path — extracted, never
 * mirrored.
 */
export function buildChildEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GENIRO_') && !STRIPPED_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

/**
 * The claude-child re-injection of the Anthropic credentials
 * {@link buildChildEnv} strips: whichever of them the daemon itself inherited,
 * for spawn paths that are definitionally claude (the Claude adapter's turns,
 * the claude-only PTY terminal mirror). One shared source for both paths —
 * extracted, never mirrored.
 */
export function claudeCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_CREDENTIAL_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}
