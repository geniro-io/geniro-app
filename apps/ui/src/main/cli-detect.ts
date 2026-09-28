import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type Settings,
} from '../shared/contracts';
import { descriptorFor } from './agents/agent-descriptors';
import { probeUpdate, UNKNOWN_CLI_UPDATE } from './cli-update';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/**
 * Ask one CLI whether it is signed in, through its own descriptor's probe
 * (`agents/`). `null` on anything that is not a clear answer — no probe for
 * this kind, a command that could not run, unparseable output. Never guess
 * `false`: the readiness chip would tell a signed-in user to sign in.
 *
 * A non-zero exit is handed to the reader rather than read as signed-out here:
 * whether a CLI's non-zero exit is an ANSWER is a fact about that CLI, and
 * the two measured JSON probes exit 0 for both answers.
 *
 * THE DAEMON HAS ITS OWN HOME for this CLI's auth facts — `AdapterConfig.auth`
 * in its adapter. This side exists because `detectClis` runs over IPC during
 * onboarding, before any daemon.
 */
async function probeLogin(
  kind: CliKind,
  path: string,
): Promise<boolean | null> {
  const probe = descriptorFor(kind).loginProbe;
  if (!probe) {
    return null;
  }
  try {
    const { stdout, stderr } = await execFileAsync(path, [...probe.args], {
      timeout: 5000,
      env: probeEnv(kind),
    });
    return probe.read({ stdout, stderr, exitCode: 0 });
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    // A numeric `code` is the binary's own exit status — it ran and answered.
    // Anything else (ENOENT, a timeout's kill) is a question that failed.
    return typeof failure.code === 'number'
      ? probe.read({
          stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
          stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
          exitCode: failure.code,
        })
      : null;
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
          update: UNKNOWN_CLI_UPDATE,
        };
      }
      // All three probes are independent reads of the same binary, so they run
      // together rather than adding another serial 5s worst case to startup.
      const [version, loggedIn, update] = await Promise.all([
        probeVersion(kind, path),
        probeLogin(kind, path),
        probeUpdate(kind, path),
      ]);
      return { kind, found: version !== null, path, version, loggedIn, update };
    }),
  );
}
