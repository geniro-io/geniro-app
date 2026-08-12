import type { CliKind } from '../shared/contracts';

/**
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/child-env.ts` (`STRIPPED_KEYS`).
 *
 * The daemon strips these names from every child it spawns and re-injects only
 * what that child is entitled to, so no spawned agent inherits another agent's
 * credential. The Electron main process spawns CLI children too — `detectClis`
 * runs `--version` and `status` on BOTH binaries — and had no equivalent gate,
 * so it handed the user's Cursor key to `claude` and their Anthropic keys to
 * `cursor-agent`. The two apps share no code (importing daemon source would pull
 * the Nest graph into the main bundle), so this is a deliberate twin.
 *
 * **The two sides are NOT mirror images, and assuming they were is how a reader
 * mirrors wrongly.** The daemon strips a UNION from every child, so it withholds
 * `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_SESSION_ID` even from CLAUDE's own
 * children: there a chat's profile is part of the run's identity, and an
 * inherited one would silently override what the run chose. A probe has no run
 * identity to protect — it asks one binary about itself — so those two are
 * classified here as claude's OWN and only cursor is denied them.
 *
 * The obligation across the twin is therefore narrower than "keep the lists
 * equal": a CREDENTIAL added to the daemon's set belongs here, under whichever
 * agent owns it.
 */
/**
 * Exported so the spec can assert over EVERY member rather than a hand-picked
 * pair. A test naming two of these names covers two of them; a test looping the
 * list covers whatever it grows to, which is the property that matters for a
 * list whose whole job is to be complete.
 */
export const CURSOR_ONLY_KEYS = ['CURSOR_API_KEY'] as const;

/** @see CURSOR_ONLY_KEYS for why this is exported. */
export const CLAUDE_ONLY_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Not a credential, but the same class of leak: it names the OUTER Claude Code
  // session and a chosen profile, neither of which is this probe's business.
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CONFIG_DIR',
] as const;

/**
 * What each CLI is entitled to KEEP. A keyed record, not a `kind === 'x' ? … : …`
 * ternary: under a ternary every kind that is not the one named falls into the
 * `else` and inherits the other agent's credentials, so a third CLI would leak
 * claude's token with no code change and no failing test — the exact failure this
 * file exists to prevent. Keyed, an unlisted kind keeps nothing.
 */
const OWN_KEYS: Record<CliKind, readonly string[]> = {
  claude: CLAUDE_ONLY_KEYS,
  'cursor-agent': CURSOR_ONLY_KEYS,
};

/** Every credential name this module knows about, whoever owns it. */
const ALL_KEYS: readonly string[] = [...CLAUDE_ONLY_KEYS, ...CURSOR_ONLY_KEYS];

/**
 * The environment for a one-shot probe of ONE CLI binary: the process env minus
 * every other agent's credentials.
 *
 * `status` is the reason this matters more than it used to. `--version` is inert,
 * but a login-state probe is an authenticated call that talks to the vendor's
 * API, so it is exactly the kind of child that must not be holding a rival
 * agent's token.
 */
export function probeEnv(kind: CliKind): NodeJS.ProcessEnv {
  const own = OWN_KEYS[kind];
  const withheld = ALL_KEYS.filter((key) => !own.includes(key));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!withheld.includes(key)) {
      env[key] = value;
    }
  }
  return env;
}
