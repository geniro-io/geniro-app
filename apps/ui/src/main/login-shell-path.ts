import { type ChildProcess, spawn } from 'node:child_process';

const MARKER = '__GENIRO_PATH__';

/** More than any real PATH plus rc banners; a shell printing past it is noise. */
const MAX_STDOUT_CHARS = 256 * 1024;

/**
 * How long after the shell EXITS its output is still waited for.
 *
 * `close` — every holder of the stdout pipe gone — is the normal ending, and
 * it can be never: an rc file that starts a background job without
 * redirecting it hands that job our pipe, and the job outlives the shell. The
 * echo this parses is the shell's LAST act, so by `exit` it has been written;
 * this is only the drain of what the pipe still holds.
 */
const EXIT_DRAIN_MS = 100;

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
 * — accepted in the M4 review; this file is the whole surface we need.
 *
 * **It must END, whatever the user's rc files do**, because the daemon's
 * spawn awaits it and `before-quit` awaits the spawn. It used to be an
 * `execFile` with a `timeout`, which bounded nothing: an INTERACTIVE zsh
 * ignores the SIGTERM that timeout sends, and its stdin was an open pipe, so
 * an rc file that reads from the terminal simply waited forever — measured, a
 * `zsh -ilc 'read x'` under a 1000ms timeout was still alive at 6000ms, and
 * its callback never fired until something else killed it. So three things,
 * each closing its own way to hang:
 * - stdin is `/dev/null`, so a `read` in an rc file gets EOF at once;
 * - the deadline sends SIGKILL, which no shell can ignore;
 * - the deadline RESOLVES the promise itself, rather than waiting for the
 *   pipe to close — a background job the rc started may hold it open after
 *   the shell is gone.
 */
export function loginShellPath(
  timeoutMs = 3000,
  shell = process.env.SHELL || '/bin/zsh',
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child: ChildProcess | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadline !== null) {
        clearTimeout(deadline);
      }
      // Our end of the pipe, released so a straggler holding the other end
      // keeps nothing of this process alive.
      child?.stdout?.destroy();
      resolve(parseLoginShellPath(stdout));
    };
    try {
      child = spawn(shell, ['-ilc', `echo "${MARKER}$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const spawned = child;
    deadline = setTimeout(() => {
      try {
        spawned.kill('SIGKILL');
      } catch {
        // Already gone — the resolve below is all that is left to do.
      }
      finish();
    }, timeoutMs);
    spawned.stdout?.setEncoding('utf8');
    spawned.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_CHARS) {
        stdout += chunk;
      }
    });
    // A shell that could not be started (no such binary) reports it here, not
    // as a throw from `spawn`.
    spawned.on('error', finish);
    spawned.on('close', finish);
    spawned.on('exit', () => {
      setTimeout(finish, EXIT_DRAIN_MS);
    });
  });
}
