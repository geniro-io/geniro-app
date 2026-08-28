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
 *
 * TWIN PARSER: `apps/daemon/src/v1/handoff/utils/shell-line.ts` `shellLine`
 * renders the SAME `HandoffTarget` (command + args + env) as the one pasteable
 * line the button shows on hover. Two renderings of one invocation, in two apps
 * that share no code, so a change to what env a target carries must land on
 * both. They differ in exactly one respect, deliberately: a pasted line uses
 * the `NAME=value cmd …` prefix form, while this script must export ahead of
 * its `exec` (see the exec comment below). Adding a field here without adding
 * it there ships a button and a copyable line that do different things.
 */
export async function openInTerminal(input: {
  command: string;
  args: string[];
  cwd: string;
  /**
   * Env the invocation needs — today the run's config directory, which decides
   * which ACCOUNT the reopened conversation belongs to and has no argv form.
   * Exported in the script ahead of the exec, so it reaches the CLI and dies
   * with the window.
   */
  env?: Record<string, string>;
}): Promise<void> {
  // `exec` so the shell becomes the CLI: closing the CLI closes the window's
  // process rather than dropping the user at a stray prompt.
  //
  // Each variable gets its own assignment + `export` LINE, ahead of the exec —
  // NOT the `NAME=value cmd …` prefix form the daemon's `shellLine` twin
  // renders. A shell recognizes assignments only ahead of a simple command's
  // FIRST word, and here that word is `exec`, so `exec NAME=value cmd` hands
  // `NAME=value` to exec as the program to run; containing a `/`, it is then
  // resolved as a path, and the window dies on
  // `<cwd>/NAME=value: No such file or directory`. The twin is correct because
  // a pasted line has no `exec` in front of it.
  //
  // Sorted for the reason `shellLine` sorts: one target must always render the
  // same script. Only the value is quoted — a name is an identifier, and
  // quoting the pair would assign to nothing.
  const exportLines = Object.entries(input.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${quote(value)}\nexport ${name}\n`)
    .join('');
  await runInTerminal(
    'continue-in-cli',
    input.cwd,
    `${exportLines}exec ${[input.command, ...input.args].map(quote).join(' ')}\n`,
  );
}

/**
 * Open the user's terminal ON A FOLDER — a plain shell, no command.
 *
 * The other half of {@link openInTerminal}, and deliberately a separate export
 * rather than that one with an optional `command`: what reaches the script is
 * different in kind. There the renderer hands over an invocation the DAEMON
 * composed and this process quotes; here it hands over a directory and nothing
 * else, so there is no argv and no env for a tampered renderer to smuggle
 * anything through — which is also why the IPC schema behind it is a bare path.
 *
 * The shell is resolved at RUN time, inside the window, rather than from this
 * process's own `SHELL`: a packaged Finder launch inherits launchd's minimal
 * environment (the same reason `login-shell-path.ts` exists), while the
 * terminal app that runs this script always sets it from the user record. The
 * fallback is macOS's own default login shell, since this path is macOS-only.
 * `-l` because a terminal window opened from the Dock is a login shell too —
 * without it the user lands at a prompt whose PATH and prompt string are not
 * the ones they have everywhere else.
 */
export async function openTerminalAt(input: { cwd: string }): Promise<void> {
  await runInTerminal(
    'terminal-here',
    input.cwd,
    'exec "${SHELL:-/bin/zsh}" -l\n',
  );
}

/**
 * Write a `.command` script that enters `cwd` and then runs `body`, and hand it
 * to LaunchServices.
 *
 * Shared by both entry points above so the parts that are easy to get wrong —
 * the platform refusal, the private 0700 directory, the mode, the `cd` guard,
 * the `open` — exist once. `body` is the only thing that differs, and each
 * caller composes its own because the quoting rules differ with it.
 *
 * The darwin check lives HERE rather than in each entry point on purpose: the
 * whole mechanism below is macOS-specific (`.command`, LaunchServices, `open`),
 * so a third caller added later inherits the refusal instead of having to
 * remember it — and it throws before anything is written, so a refused call
 * leaves no script behind.
 */
async function runInTerminal(
  name: string,
  cwd: string,
  body: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('opening a terminal is macOS-only in this build');
  }
  const dir = mkdtempSync(join(tmpdir(), 'geniro-open-'));
  const script = join(dir, `${name}.command`);
  writeFileSync(script, `#!/bin/sh\ncd ${quote(cwd)} || exit 1\n${body}`, {
    mode: 0o700,
  });
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
