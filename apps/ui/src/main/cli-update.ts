import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import type {
  CliKind,
  CliUpdateResult,
  CliUpdateState,
  Settings,
} from '../shared/contracts';
import type { RecordedLatestProbe } from './agents/agent-descriptor';
import { descriptorFor } from './agents/agent-descriptors';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

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
 * Ask one CLI whether a newer version of it exists, through its own
 * descriptor's probe (`agents/`). Never installs anything.
 *
 * Every failure — a command that failed, unparseable output, a status word the
 * CLI does not vouch for — lands on `available: null`. Guessing `false` would hide a real update behind a screen that says
 * there is none; guessing `true` would offer an install with nothing behind it.
 */
export async function probeUpdate(
  kind: CliKind,
  path: string,
  context: UpdateProbeContext,
): Promise<CliUpdateState> {
  const probe = descriptorFor(kind).latestProbe;
  if ('unavailableReason' in probe) {
    return {
      ...UNKNOWN_CLI_UPDATE,
      checkUnavailableReason: probe.unavailableReason,
    };
  }
  if ('recordPath' in probe) {
    return readRecordedUpdate(kind, probe, context);
  }
  try {
    const { stdout } = await execFileAsync(path, [...probe.args], {
      timeout: PROBE_TIMEOUT_MS,
      env: probeEnv(kind),
    });
    return { ...probe.read(stdout), checkUnavailableReason: null };
  } catch {
    return UNKNOWN_CLI_UPDATE;
  }
}

/** What a probe may need beyond the binary itself. */
export interface UpdateProbeContext {
  /**
   * The installed `--version` line — a promise, so a probe that does not need
   * it never waits on it and `detectClis` still runs every probe at once.
   */
  version: Promise<string | null>;
  /** The config homes the user runs this CLI under, besides its default. */
  configDirs: readonly string[];
  /** Injected for specs; the real clock otherwise. */
  now?: number;
}

/**
 * The CLI's own last check, read from the freshest record across its config
 * homes. A record that says "nothing newer" is believed only within the CLI's
 * own re-check interval; past it — or with no record at all — the card says
 * how to get one rather than claiming either answer.
 */
async function readRecordedUpdate(
  kind: CliKind,
  probe: RecordedLatestProbe,
  context: UpdateProbeContext,
): Promise<CliUpdateState> {
  const unanswered: CliUpdateState = {
    ...UNKNOWN_CLI_UPDATE,
    checkUnavailableReason: probe.unansweredReason,
  };
  const installed = await context.version;
  if (installed === null) {
    return unanswered;
  }
  const env = probeEnv(kind);
  const paths = new Set(
    [null, ...context.configDirs].map((dir) =>
      probe.recordPath(dir, env, homedir()),
    ),
  );
  const answers = await Promise.all(
    [...paths].map(async (file) => {
      try {
        return probe.read(await readFile(file, 'utf8'), installed);
      } catch {
        return null;
      }
    }),
  );
  const freshest = answers
    .filter((answer) => answer !== null)
    .sort((a, b) => b.checkedAt - a.checkedAt)[0];
  if (!freshest || freshest.available === null) {
    return unanswered;
  }
  const now = context.now ?? Date.now();
  if (!freshest.available && now - freshest.checkedAt > probe.freshForMs) {
    return unanswered;
  }
  return {
    available: freshest.available,
    latestVersion: freshest.latestVersion,
    checkUnavailableReason: null,
  };
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
    await execFileAsync(path, [...descriptorFor(kind).updateArgs], {
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
