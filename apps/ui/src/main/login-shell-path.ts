import { execFile } from 'node:child_process';

const MARKER = '__GENIRO_PATH__';

/**
 * Parse the login shell's echoed PATH out of its (rc-noisy) stdout. The echo
 * is prefixed with a {@link MARKER} sentinel so the real value is found even
 * when rc files print banners: take the last marker-prefixed line. The result
 * must contain a `:` — a colon-separated PATH — which rejects fish's
 * space-joined `"$PATH"` expansion (a single space-riddled token that would
 * otherwise replace the daemon's PATH with garbage). Returns null when no
 * usable value is found; the caller then keeps the inherited PATH.
 */
export function parseLoginShellPath(stdout: string): string | null {
  const marked = stdout
    .split('\n')
    .reverse()
    .find((line) => line.startsWith(MARKER));
  const path = marked?.slice(MARKER.length).trim();
  return path && path.includes(':') ? path : null;
}

/**
 * Resolve the user's login-shell PATH. A Finder-launched app inherits
 * launchd's minimal PATH (`/usr/bin:/bin:…`), which lacks the user's
 * package-manager bin dirs — exactly where `claude` / `cursor-agent` live.
 * The daemon (and every agent/PTY child it spawns) needs the interactive
 * PATH, so ask the user's shell once at daemon start. `-ilc` loads both the
 * login and interactive rc files (CLI installers write to either). Null on any
 * failure/timeout — the caller keeps the inherited PATH. Deliberately
 * hand-rolled (zero-dep, CJS-safe) instead of adopting `shell-env`/`fix-path`
 * — accepted in the M4 review; these ~40 lines are the whole surface we need.
 */
export function loginShellPath(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(
      shell,
      ['-ilc', `echo "${MARKER}$PATH"`],
      { timeout: timeoutMs },
      (err, stdout) => {
        resolve(err ? null : parseLoginShellPath(stdout));
      },
    );
  });
}
