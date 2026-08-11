import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Open the user's terminal on a command — the handoff out of geniro.
 *
 * Via a `.command` script and `open`, deliberately, rather than
 * `open -a Terminal`: LaunchServices routes `.command` to whatever the user has
 * set as its handler, so someone on iTerm, Ghostty or WezTerm lands in THEIR
 * terminal instead of being dropped into Terminal.app. That is what "the system
 * default" means on macOS — there is no API for a default terminal, only this
 * file association.
 *
 * The script is written with 0700 into a fresh private directory: it is
 * executable and it names the folder the agent is working in, so it must not be
 * world-readable in a shared temp dir. It is left behind on purpose — the
 * terminal reads it asynchronously, and deleting it on a timer would be a race
 * against a slow app launch for a few hundred bytes.
 */
export async function openInTerminal(input: {
  command: string;
  args: string[];
  cwd: string;
  /**
   * Env the invocation needs — today the run's config directory, which decides
   * which ACCOUNT the reopened conversation belongs to and has no argv form.
   * Written as a prefix assignment on the exec line, so it applies to the CLI
   * and dies with it.
   */
  env?: Record<string, string>;
}): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('opening a terminal is macOS-only in this build');
  }
  const dir = mkdtempSync(join(tmpdir(), 'geniro-open-'));
  const script = join(dir, 'continue-in-cli.command');
  // `exec` so the shell becomes the CLI: closing the CLI closes the window's
  // process rather than dropping the user at a stray prompt. The line itself
  // is quoted by the daemon, which is also what the user sees and can copy.
  // Sorted for the same reason the daemon's `shellLine` sorts: one target must
  // always render the same script. Only the value is quoted — an assignment is
  // not an argument, and re-quoting it would make the shell hunt for a command
  // named `NAME=value`.
  const assignments = Object.entries(input.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${quote(value)} `)
    .join('');
  writeFileSync(
    script,
    `#!/bin/sh\ncd ${quote(input.cwd)} || exit 1\nexec ${assignments}${[input.command, ...input.args].map(quote).join(' ')}\n`,
    { mode: 0o700 },
  );
  chmodSync(script, 0o700);
  await new Promise<void>((resolve, reject) => {
    execFile('open', [script], (error) => (error ? reject(error) : resolve()));
  });
}

/** Single-quote anything a shell would otherwise act on. */
function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && value.length > 0
    ? value
    : `'${value.split("'").join(`'\\''`)}'`;
}
