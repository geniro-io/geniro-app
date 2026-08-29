import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type Settings,
} from '../shared/contracts';
import { probeEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

async function probeVersion(
  kind: CliKind,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: 5000,
      env: probeEnv(kind),
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * How to ask one CLI whether it is signed in, for the CLIs that can be asked.
 *
 * A TABLE rather than a branch, so a third CLI is one entry and not another
 * `if`. A kind absent from it has no way to be asked and reports `loggedIn:
 * null`.
 *
 * THE DAEMON HAS ITS OWN HOME for this CLI's auth facts —
 * `AdapterConfig.auth` (`loginArgs`, `logoutArgs`, `expiredMarkers`) in that
 * CLI's adapter. This table is the Electron-side twin, and it exists here rather
 * than there because its one reader is `detectClis` over IPC, which Onboarding
 * calls before any `DaemonHandle` exists. A CLI added to `AdapterConfig.auth`
 * and NOT to this table reports `loggedIn: null` — ready — even when signed out,
 * silently.
 *
 * **claude's entry is a CORRECTED measurement, not a new feature.** This table
 * used to name it as deliberately absent, on the reasoning that its credentials
 * travel as env vars the daemon manages and so there was no question to put to
 * the binary. That was wrong when written and is measurably wrong now: `claude
 * auth status --json` answers `{"loggedIn": true, "authMethod": "claude.ai", …}`
 * and, under an empty `CLAUDE_CONFIG_DIR`, `{"loggedIn": false, "authMethod":
 * "none", …}` — probe-verified on 2.1.227, exit 0 for BOTH answers, and it
 * honours the config directory. The cost of the wrong reading was not
 * cosmetic: claude's card could never say "not signed in", so the account
 * control had no state to reflect and offered Sign in to an account that was
 * already signed in. `--json` is passed explicitly although the CLI documents it
 * as the default, so a future default flip cannot silently hand this parser
 * prose.
 *
 * **Ask for the CLI's STRUCTURED answer, never its prose.** `cursor-agent
 * status --format json` returns `{"status":…,"isAuthenticated":bool,…}`
 * (verified on 2026.08.11-e8db854). Matching the human output instead was a real
 * defect: that binary has a THIRD state, `partially-authenticated`, which prints
 * `Partially authenticated (missing refresh token)` — neither "logged in as" nor
 * "not logged in" — so a half-expired session read as UNKNOWN and the readiness
 * chip rendered it ready, while turns failed with `Authentication required`. A
 * boolean field cannot drift that way, and it survives a re-worded message.
 *
 * `booleanField` names the boolean to read, so a second CLI declares its own
 * field rather than sharing cursor's spelling. A FLAT key, deliberately — it is
 * not a path, and naming it one would invite `'auth.isAuthenticated'`, which
 * would read `undefined` → `null` → a chip that says ready while signed out.
 */
const LOGIN_PROBES: Partial<
  Record<CliKind, { args: string[]; booleanField: string }>
> = {
  'cursor-agent': {
    args: ['status', '--format', 'json'],
    booleanField: 'isAuthenticated',
  },
  claude: {
    args: ['auth', 'status', '--json'],
    booleanField: 'loggedIn',
  },
};

/**
 * Ask one CLI whether it is signed in. `null` on anything that is not a clear
 * answer — no probe for this kind, the command failed, unparseable output, or a
 * reply missing the boolean. Never guess `false`: the readiness chip would tell
 * a signed-in user to sign in, and the control it offers would fix nothing.
 *
 * A non-zero exit is NOT read as signed-out, deliberately: this CLI exits 0 for
 * both the authenticated and unauthenticated answers, so a throw here means the
 * question failed rather than that the answer was no.
 */
async function probeLogin(
  kind: CliKind,
  path: string,
): Promise<boolean | null> {
  const probe = LOGIN_PROBES[kind];
  if (!probe) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(path, probe.args, {
      timeout: 5000,
      env: probeEnv(kind),
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)[probe.booleanField];
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Probe the host for each supported CLI agent (path, reported version, and
 * whether it reports itself signed in).
 */
export async function detectClis(settings: Settings): Promise<CliDetection[]> {
  return Promise.all(
    CLI_KINDS.map(async (kind): Promise<CliDetection> => {
      const path = resolveBinary(kind, settings.cliPaths[kind]);
      if (!path) {
        return {
          kind,
          found: false,
          path: null,
          version: null,
          loggedIn: null,
        };
      }
      // Both probes are independent reads of the same binary, so they run
      // together rather than adding a second serial 5s worst case to startup.
      const [version, loggedIn] = await Promise.all([
        probeVersion(kind, path),
        probeLogin(kind, path),
      ]);
      return { kind, found: version !== null, path, version, loggedIn };
    }),
  );
}
