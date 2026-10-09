import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CliInstallResult, CliKind, Settings } from '../shared/contracts';
import { descriptorFor } from './agents/agent-descriptors';
import { probeVersion } from './cli-version';
import { probeEnv } from './probe-env';
import { loginShellPathSettled } from './process-path';
import { resolveBinary } from './resolve-binary';

const execFileAsync = promisify(execFile);

/**
 * An install DOWNLOADS a whole CLI — claude's native build is ~200MB — so it
 * gets the updater's budget rather than a probe's.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The longest failure sentence the card shows; the whole output stays on hover. */
const MAX_REASON_CHARS = 240;

/** How much of a failed installer's output travels back for the user to read. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Installs in flight, by CLI. A second press — another window, or a phone on
 * the LAN gateway — JOINS the running one rather than starting a second
 * installer over the files the first is writing.
 */
const inFlight = new Map<CliKind, Promise<CliInstallResult>>();

/**
 * The shell line that runs `kind`'s installer — the vendor's own one-liner,
 * spelled with absolute paths because a packaged app may still be running
 * under launchd's PATH when it is pressed. `pipefail` so a download that
 * FAILED is the exit status, not the shell's happy exit over an empty script.
 *
 * The URL is a constant from the descriptor, never input, so quoting it is
 * belt-and-braces rather than the guard.
 */
export function installCommand(kind: CliKind): string {
  const { url, shell } = descriptorFor(kind).installer;
  return `set -o pipefail; /usr/bin/curl -fsSL '${url}' | ${shell}`;
}

/** One sentence on why an installer failed, from its own output. */
export function installFailureReason(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? 'The installer failed.';
  return last.length > MAX_REASON_CHARS
    ? `${last.slice(0, MAX_REASON_CHARS - 1)}…`
    : last;
}

/**
 * Install one CLI by running its VENDOR's installer, and report in geniro's
 * terms whether it worked.
 *
 * "Worked" is measured, never read off the script: the binary detection now
 * resolves has to answer `--version`. That is what the card needs to call the
 * agent ready, and an installer that exits 0 having put the binary somewhere
 * detection does not look is a failure the user should be told about rather
 * than a success that leaves the card saying "not installed".
 */
export function runCliInstall(
  kind: CliKind,
  settings: Settings,
): Promise<CliInstallResult> {
  const running = inFlight.get(kind);
  if (running) {
    return running;
  }
  const run = install(kind, settings).finally(() => inFlight.delete(kind));
  inFlight.set(kind, run);
  return run;
}

async function install(
  kind: CliKind,
  settings: Settings,
): Promise<CliInstallResult> {
  // The scripts run `uname`, `mkdir`, `shasum`… off PATH, and a Finder launch
  // is still adopting the login shell's while the first screen is up.
  await loginShellPathSettled();
  const { env } = descriptorFor(kind).installer;
  try {
    await execFileAsync('/bin/bash', ['-c', installCommand(kind)], {
      timeout: INSTALL_TIMEOUT_MS,
      env: { ...probeEnv(kind), ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const failure = err as {
      stderr?: unknown;
      stdout?: unknown;
      killed?: boolean;
    };
    const full = [failure.stderr, failure.stdout]
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .trim();
    const said =
      full.length > 0
        ? full.slice(-MAX_OUTPUT_CHARS)
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      kind,
      ok: false,
      version: null,
      path: null,
      output: said,
      reason: failure.killed
        ? `The ${kind} installer did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes.`
        : installFailureReason(said),
    };
  }
  return verifyInstalled(kind, settings);
}

/** What detection finds after a clean installer exit. */
async function verifyInstalled(
  kind: CliKind,
  settings: Settings,
): Promise<CliInstallResult> {
  const pinned = settings.cliPaths[kind];
  const path = resolveBinary(kind, pinned);
  const version = path ? await probeVersion(kind, path) : null;
  if (path && version) {
    return { kind, ok: true, version, path, output: null, reason: null };
  }
  // A pinned path that does not answer outranks the fresh install in
  // detection — the one case where the install worked and the card would still
  // say otherwise, so it is named rather than reported as a failed install.
  const unpinned = pinned ? resolveBinary(kind) : null;
  if (unpinned && unpinned !== path && (await probeVersion(kind, unpinned))) {
    return {
      kind,
      ok: false,
      version: null,
      path,
      output: null,
      reason: `${kind} was installed at ${unpinned}, but the binary path set for it (${pinned}) does not run — clear that field to use the new one.`,
    };
  }
  return {
    kind,
    ok: false,
    version: null,
    path,
    output: null,
    reason: `The installer finished, but no working ${kind} was found afterwards.`,
  };
}
