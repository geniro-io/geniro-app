/**
 * Env keys a spawned child must NEVER inherit, beyond the `GENIRO_` prefix:
 *
 * - `CURSOR_API_KEY` — natively inherited Cursor credential; the daemon
 *   receives it as `GENIRO_CURSOR_API_KEY` and the Cursor adapter re-injects
 *   it via `extra` for its own child ONLY.
 * - `CLAUDE_CODE_SESSION_ID` — present when the APP itself was launched from
 *   inside a Claude Code session (e.g. `pnpm dev` in its terminal). It names
 *   the OUTER session's identity; a spawned agent's conversation is never
 *   that session, so the daemon must not advertise it to children — an agent
 *   or its tools binding to it would cross-wire thread resume, session
 *   capture, and per-thread terminal mirrors onto one session file.
 * - {@link CLAUDE_CREDENTIAL_KEYS} — Anthropic credentials inherited when the
 *   app/daemon was launched from a shell that exports them. Stripping them
 *   keeps the cursor→claude and claude→cursor directions symmetric: only the
 *   definitionally-claude spawn paths (the Claude adapter's turns, the
 *   claude-only PTY mirror) re-inject them via {@link claudeCredentialEnv}.
 */
const CLAUDE_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

const STRIPPED_KEYS = new Set([
  'CURSOR_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
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
