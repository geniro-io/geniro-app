import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CliKind,
  CliUpdateResult,
  CliUpdateState,
  Settings,
} from '../shared/contracts';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/**
 * How to ask ONE CLI what the newest version is WITHOUT installing it.
 *
 * A TABLE like `LOGIN_PROBES` next door, for its reason: a third CLI is an
 * entry rather than another `if`, and a kind absent from it declares WHY in
 * {@link CHECK_UNAVAILABLE} instead of silently reporting "no update".
 *
 * **Ask for the CLI's STRUCTURED answer, never its prose** — the same rule the
 * login probe records. `cursor-agent about` prints
 * `Latest  2026.09.02-c22c1a3 (update available — run \`agent update\`)`, one
 * line carrying two facts inside a parenthetical, while `--format json` answers
 * `{"cliVersion":…,"latestStatus":"update_available","latestVersion":…}`
 * (measured 2026-09-03 on 2026.08.31-4057e58, 1188ms).
 *
 * **The two status markers are the CLI's own vocabulary, read out of its own
 * source rather than inferred from one observation.** Its bundle switches on
 * exactly two — `switch(e.latestStatus){case"up_to_date":case"update_available":`
 * — so those are the only values it vouches for and anything else reads as
 * unknown. Sampling the live command could only ever have shown whichever state
 * this machine happened to be in.
 *
 * `statusField` / `versionField` / the two markers are named per entry, so a
 * second CLI declares its own spelling instead of inheriting cursor's — the
 * `booleanField` design, and the same trap it avoids: a shared literal that one
 * vendor renames silently answers `null` forever.
 */
const LATEST_PROBES: Partial<
  Record<
    CliKind,
    {
      args: string[];
      statusField: string;
      versionField: string;
      upToDate: string;
      updateAvailable: string;
    }
  >
> = {
  'cursor-agent': {
    args: ['about', '--format', 'json'],
    statusField: 'latestStatus',
    versionField: 'latestVersion',
    upToDate: 'up_to_date',
    updateAvailable: 'update_available',
  },
};

/**
 * Why a CLI absent from {@link LATEST_PROBES} cannot be asked — a MEASURED fact
 * about that CLI, said on its card rather than left as a blank the reader would
 * take for "you are up to date".
 *
 * claude's was measured three ways on 2.1.251 (2026-09-03), because "there is
 * no check" is exactly the claim that ages badly: `claude update|upgrade` is
 * documented as "Check for updates and install if available" and offers no
 * `--check`/`--dry-run` (its `--help` lists `-h` alone); `~/.claude.json`
 * caches `installMethod`, `autoUpdates` and `lastReleaseNotesSeen` but no
 * latest-version figure; and `claude doctor` reports the INSTALL (`Last update
 * attempt: success → 2.1.251`) and never what is available. The binary does
 * carry its release host, `https://downloads.claude.ai/claude-code-releases/`
 * — deliberately NOT read here: geniro asks the user's own CLI about the user's
 * own install, and fetching a vendor's release manifest itself would be an
 * outbound call of geniro's own, which this app does not make.
 */
export const CHECK_UNAVAILABLE: Partial<Record<CliKind, string>> = {
  claude:
    'claude has no check of its own — it looks for a new version only while installing one.',
};

/**
 * The argv that updates one CLI, per CLI.
 *
 * A total `Record` and not a `Partial` one: both shipped CLIs have an updater,
 * so there is no absence to express today, and the exhaustiveness is what makes
 * a third CLI a COMPILE error until whoever adds it decides. A CLI with none
 * would need a reason on the wire and a card that renders no button — the same
 * shape {@link CHECK_UNAVAILABLE} takes — rather than a press that resolves
 * nothing.
 */
const UPDATE_COMMANDS: Record<CliKind, string[]> = {
  // "Check for updates and install if available" — its own `--help`. So this
  // one argv is both halves for claude, which is why its card offers the button
  // unconditionally.
  claude: ['update'],
  'cursor-agent': ['update'],
};

/**
 * Nothing is known, and nothing is claimed — the state for a CLI that was not
 * found at all. `checkUnavailableReason` stays null there deliberately: the
 * card already says "not found on PATH", and explaining why an absent binary
 * cannot be asked about updates would be the second answer to a question the
 * user is not asking.
 */
export const UNKNOWN_CLI_UPDATE: CliUpdateState = {
  available: null,
  latestVersion: null,
  checkUnavailableReason: null,
};

/**
 * The same 5s budget the version and login probes use, and a network call
 * inside it (measured 1188ms). Exceeding it yields `null` — "not known" — which
 * is the safe direction: a slow link costs the user the readout, never a wrong
 * claim about their install.
 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * An update DOWNLOADS AND INSTALLS a whole CLI — claude's native build is
 * ~200MB — so this is minutes, not seconds, and shares no budget with the
 * probes above.
 */
const UPDATE_TIMEOUT_MS = 10 * 60_000;

/** How much of a failed updater's output travels back for the user to read. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Ask one CLI whether a newer version of it exists. Never installs anything.
 *
 * Every failure — no probe for this kind, a command that failed, unparseable
 * output, a status word the CLI does not vouch for — lands on `available:
 * null`. Guessing `false` would hide a real update behind a screen that says
 * there is none; guessing `true` would offer an install with nothing behind it.
 */
export async function probeUpdate(
  kind: CliKind,
  path: string,
): Promise<CliUpdateState> {
  const probe = LATEST_PROBES[kind];
  if (!probe) {
    return {
      ...UNKNOWN_CLI_UPDATE,
      checkUnavailableReason: CHECK_UNAVAILABLE[kind] ?? null,
    };
  }
  try {
    const { stdout } = await execFileAsync(path, probe.args, {
      timeout: PROBE_TIMEOUT_MS,
      env: probeEnv(kind),
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return UNKNOWN_CLI_UPDATE;
    }
    const row = parsed as Record<string, unknown>;
    const status = row[probe.statusField];
    const latest = row[probe.versionField];
    return {
      available:
        status === probe.updateAvailable
          ? true
          : status === probe.upToDate
            ? false
            : null,
      latestVersion:
        typeof latest === 'string' && latest.length > 0 ? latest : null,
      checkUnavailableReason: null,
    };
  } catch {
    return UNKNOWN_CLI_UPDATE;
  }
}

/** The tail of whatever a failed updater said, bounded and trimmed. */
function outputTail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}

/**
 * Run one CLI's own updater, and report what it did in GENIRO's terms.
 *
 * The report is built from two `--version` reads taken either side of the run
 * rather than from the updater's output, and that is the whole design: the two
 * CLIs word their outcome differently and may reword it in any release, while
 * "what does the binary answer now" is a measurement this app takes for itself.
 * The updater's own words survive only for a FAILURE, where geniro has nothing
 * better to offer than what the tool said.
 *
 * The binary is resolved TWICE for the same reason. claude's native install is
 * a symlink into `~/.local/share/claude/versions/<v>` that its updater
 * repoints, so re-resolving after the run reads whatever is installed now
 * instead of trusting a path captured before it moved.
 */
export async function runCliUpdate(
  kind: CliKind,
  settings: Settings,
): Promise<CliUpdateResult> {
  const path = resolveBinary(kind, settings.cliPaths[kind]);
  if (!path) {
    return {
      kind,
      ok: false,
      previousVersion: null,
      version: null,
      output: `${kind} was not found on PATH.`,
    };
  }
  const previousVersion = await probeVersion(kind, path);
  try {
    await execFileAsync(path, UPDATE_COMMANDS[kind], {
      timeout: UPDATE_TIMEOUT_MS,
      env: probeEnv(kind),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const failure = err as { stderr?: unknown; stdout?: unknown };
    return {
      kind,
      ok: false,
      previousVersion,
      // Read back even on a failure: an updater that swapped the binary and
      // then exited non-zero has still changed what the next turn will run, and
      // a card reporting the pre-run version would be describing a binary that
      // is no longer there.
      version: await probeVersion(
        kind,
        resolveBinary(kind, settings.cliPaths[kind]) ?? path,
      ),
      output:
        outputTail(failure.stderr) ??
        outputTail(failure.stdout) ??
        (err instanceof Error ? err.message : String(err)),
    };
  }
  return {
    kind,
    ok: true,
    previousVersion,
    version: await probeVersion(
      kind,
      resolveBinary(kind, settings.cliPaths[kind]) ?? path,
    ),
    output: null,
  };
}
