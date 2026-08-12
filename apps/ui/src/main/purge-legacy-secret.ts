import { execFile } from 'node:child_process';

/** Where earlier versions wrote the one secret this app ever held. */
const LEGACY_SERVICE = 'io.geniro.app';
const LEGACY_ACCOUNT = 'cursor.apiKey';

/**
 * Absolute, not `security` on PATH. A bare name lets PATH ORDER decide what
 * executes, so a binary of that name planted anywhere ahead of `/usr/bin` would
 * run with this app's privileges — and a packaged Finder launch inherits
 * launchd's PATH, which this process does not control. The macOS tool is always
 * at this path.
 */
const SECURITY_BIN = '/usr/bin/security';

/**
 * The ONE call shape this module uses, so the spec can inject a plain double —
 * deleting a developer's own Keychain entry from a test run would be a
 * destructive test.
 *
 * Narrowed deliberately rather than `typeof execFile`: that is an overloaded
 * signature no `vi.fn()` can satisfy, so every spec call site needed an
 * `as never`, and a cast erases exactly the check CLAUDE.md gates specs with —
 * change the argv or callback shape here and a `typeof execFile` seam still
 * compiles. Node's real `execFile` satisfies this narrower type, so production
 * passes it unchanged.
 */
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: unknown) => void,
) => void;

/**
 * Delete the Keychain entry earlier versions of this app wrote for the Cursor
 * API key, now that `cursor-agent` is confirmed to authenticate from its own
 * `~/.cursor` login and the app stores no credential of its own.
 *
 * Shells out to the macOS built-in `security` tool rather than the
 * `@napi-rs/keyring` library `keychain.ts` used to wrap, because that
 * dependency is REMOVED in this same change — this is the one place in the
 * app that still needs to reach the Keychain, and only once, so it pays for
 * itself with a spawn instead of keeping the whole library around. Always an
 * argv array, never a shell string: nothing here is built from user input, but
 * that is also why there is never a reason to open a shell for it.
 *
 * Unconditional at every launch, not gated behind a settings flag — that would
 * add persisted state for a one-time fact ("have we purged yet") this can
 * answer itself for free: exit code 44 ("item not found") is the normal
 * outcome on every launch after the first, and the whole call costs ~10ms
 * once the entry is gone. Any other failure (missing binary, a different
 * non-zero exit, a timeout, or `execFile` itself throwing before it ever
 * spawns) is swallowed — this must never fail, delay, or block app startup
 * over a courtesy cleanup.
 *
 * EXPIRY: delete this module (and its one call site) once users have
 * plausibly all upgraded past the release that removed the Cursor API key
 * path — a migration with no stated expiry is how dead code becomes
 * permanent.
 */
export function purgeLegacySecret(exec: ExecFileFn = execFile): void {
  try {
    exec(
      SECURITY_BIN,
      ['delete-generic-password', '-s', LEGACY_SERVICE, '-a', LEGACY_ACCOUNT],
      { timeout: 5000 },
      () => {
        // Swallowed unconditionally: exit 44 (not found) is the steady
        // state, and nothing else here is actionable at startup either.
      },
    );
  } catch {
    // A synchronous throw from `exec` itself — nothing to react to at
    // startup, same as any other outcome of this call.
  }
}
