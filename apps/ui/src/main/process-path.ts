import { loginShellPath } from './login-shell-path';

let adopting: Promise<string | null> | null = null;

/**
 * `primary`'s entries first, then every `inherited` entry it does not already
 * hold — so nothing the process was started with is lost, and the user's own
 * order wins wherever the two disagree.
 */
export function mergePathLists(
  primary: string,
  inherited: string | undefined,
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...primary.split(':'), ...(inherited ?? '').split(':')]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(':');
}

/**
 * Give THIS process the user's login-shell PATH, once.
 *
 * Finding a CLI is not enough to run it. `resolveBinary` probes `~/.local/bin`
 * and friends by hand, so it finds a binary installed there — but a CLI shipped
 * as a node script (npm's `codex`, a `#!/usr/bin/env node` symlink) then fails
 * on its own shebang, because under launchd's `/usr/bin:/bin:/usr/sbin:/sbin`
 * there is no `node` to find. `--version` exits 127 with
 * `env: node: No such file or directory`, and the card reads "not found on
 * PATH" about a binary sitting exactly where it was looked for. The daemon was
 * never affected — it is spawned with this same PATH — which is why a chat
 * could run the CLI that Settings said was missing.
 *
 * Writing it onto `process.env` rather than threading it through each spawn is
 * the point: every child main makes (the probes, `gh`, the updaters) reads
 * `process.env`, and a list of call sites is how one gets missed.
 *
 * Memoized: the first call starts the shell, every later one shares its answer.
 * A shell that fails or times out resolves null and leaves PATH untouched.
 */
export function adoptLoginShellPath(): Promise<string | null> {
  adopting ??= loginShellPath().then((shellPath) => {
    if (shellPath) {
      process.env.PATH = mergePathLists(shellPath, process.env.PATH);
    }
    return shellPath;
  });
  return adopting;
}

/**
 * Wait for an adoption already started, if any — never starts one. A
 * development launch inherits a terminal's PATH and starts none, so this
 * resolves at once there.
 */
export function loginShellPathSettled(): Promise<unknown> {
  return adopting ?? Promise.resolve();
}
