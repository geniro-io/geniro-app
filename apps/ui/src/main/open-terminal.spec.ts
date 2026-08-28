import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Records the `open <script>` call instead of launching the user's terminal. */
  openedWith: [] as string[][],
}));

// Only `execFile` is replaced — the spec runs the generated script through a
// REAL shell below, which needs the rest of the module intact.
vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    execFile: (
      _command: string,
      args: string[],
      callback: (error: Error | null) => void,
    ) => {
      mocks.openedWith.push(args);
      callback(null);
    },
  };
});

const { openInTerminal, openTerminalAt } = await import('./open-terminal');

const realPlatform = process.platform;

/** The function refuses to run off darwin, so every case below needs it set. */
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeAll(() => setPlatform('darwin'));
afterAll(() => setPlatform(realPlatform));

beforeEach(() => {
  mocks.openedWith.length = 0;
});

/** The `.command` path `open` was handed. */
function scriptPath(): string {
  expect(mocks.openedWith).toHaveLength(1);
  const path = mocks.openedWith[0]?.[0];
  if (path === undefined) {
    throw new Error('`open` was never called with a script path');
  }
  return path;
}

/**
 * Run the generated script through a real `/bin/sh` and return what it printed.
 *
 * This is the whole point of the suite: the script is a shell program, so the
 * only assertion that means anything is a shell's own reading of it. Asserting
 * on the file's text would pass for a line no shell can run — which is exactly
 * the state that shipped.
 */
function runScript(env?: NodeJS.ProcessEnv): {
  stdout: string;
  status: number | null;
} {
  const result = spawnSync('/bin/sh', [scriptPath()], {
    encoding: 'utf8',
    ...(env === undefined ? {} : { env }),
  });
  return { stdout: result.stdout, status: result.status };
}

/**
 * An executable standing in for the user's login shell, printing its own argv
 * and the directory it was started in.
 *
 * The folder path is what makes it usable for the awkward-path case as well:
 * the stub is written INSIDE the directory under test, so a `cd` the script
 * failed to quote correctly cannot reach it.
 */
function shellStub(dir: string): string {
  const path = join(dir, 'fake-shell');
  writeFileSync(path, `#!/bin/sh\nprintf '%s|%s' "$1" "$(pwd)"\n`, {
    mode: 0o700,
  });
  return path;
}

describe('openInTerminal', () => {
  it('hands the CLI its env — the config directory reaches the exec’d process', async () => {
    // The regression this pins: the env used to be written as a prefix
    // assignment on the `exec` line, and a shell only recognizes assignments
    // ahead of a simple command's FIRST word. With `exec` occupying that slot,
    // `CLAUDE_CONFIG_DIR=…` became exec's argument — the program to run — and
    // the window died on `<cwd>/CLAUDE_CONFIG_DIR=…: No such file or directory`
    // instead of opening the conversation.
    const configDir = mkdtempSync(join(tmpdir(), 'open-terminal-profile-'));

    await openInTerminal({
      command: '/bin/sh',
      args: ['-c', 'printf %s "$CLAUDE_CONFIG_DIR"'],
      cwd: tmpdir(),
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    // Not just "the script ran": the value has to arrive in the child's
    // environment, which is what `export` buys over a bare assignment.
    expect(runScript()).toEqual({ stdout: configDir, status: 0 });
  });

  it('carries a value a shell would otherwise split or expand', async () => {
    // A config directory is a user-chosen path, so spaces and shell
    // metacharacters are ordinary input, not an exotic case.
    const awkward = mkdtempSync(join(tmpdir(), 'open terminal $odd-'));

    await openInTerminal({
      command: '/bin/sh',
      args: ['-c', 'printf %s "$CLAUDE_CONFIG_DIR"'],
      cwd: tmpdir(),
      env: { CLAUDE_CONFIG_DIR: awkward },
    });

    expect(runScript()).toEqual({ stdout: awkward, status: 0 });
  });

  it('runs the command in the cwd it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-terminal-cwd-'));

    await openInTerminal({ command: 'pwd', args: [], cwd: dir });

    const { stdout, status } = runScript();
    expect(status).toBe(0);
    // `realpath` because macOS resolves /var → /private/var under tmpdir().
    expect(stdout.trim()).toBe(
      spawnSync('/bin/sh', ['-c', `cd ${dir} && pwd`], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
  });

  it('still produces a runnable script when the target carries no env', async () => {
    // The common case — a run on the default profile, where the export block is
    // empty. Asserting the text lacks `export` would be a proxy (and a bare
    // `export` is not even a syntax error — `sh -c 'export'` exits 0), so the
    // observable is the same one every case here uses: the script runs.
    await openInTerminal({
      command: '/bin/sh',
      args: ['-c', 'printf ok'],
      cwd: tmpdir(),
    });

    expect(runScript()).toEqual({ stdout: 'ok', status: 0 });
  });

  it('renders the same script for the same target, whatever order the env came in', async () => {
    // A set has no order of its own, and a script that reshuffles between reads
    // looks like a different command to anyone comparing two windows.
    await openInTerminal({
      command: 'true',
      args: [],
      cwd: tmpdir(),
      env: { B_VAR: 'b', A_VAR: 'a' },
    });
    const first = readFileSync(scriptPath(), 'utf8');

    mocks.openedWith.length = 0;
    await openInTerminal({
      command: 'true',
      args: [],
      cwd: tmpdir(),
      env: { A_VAR: 'a', B_VAR: 'b' },
    });

    expect(readFileSync(scriptPath(), 'utf8')).toBe(first);
  });

  it('writes the script owner-only', async () => {
    // It is executable and it names the folder the agent works in, so it must
    // not be readable by other users of a shared temp dir.
    await openInTerminal({ command: 'true', args: [], cwd: tmpdir() });

    expect(statSync(scriptPath()).mode & 0o777).toBe(0o700);
  });

  it('refuses off darwin rather than writing a script nothing will open', async () => {
    setPlatform('linux');
    try {
      await expect(
        openInTerminal({ command: 'true', args: [], cwd: tmpdir() }),
      ).rejects.toThrow(/macOS-only/);
      expect(mocks.openedWith).toHaveLength(0);
    } finally {
      setPlatform('darwin');
    }
  });
});

describe('openTerminalAt', () => {
  it('lands the user’s own login shell in the folder it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-terminal-here-'));
    const stub = shellStub(dir);

    await openTerminalAt({ cwd: dir });

    // Three claims in one reading, because the script makes them together:
    // the `cd` happened (the pwd half), `$SHELL` decided WHICH shell (the stub
    // ran at all — a hardcoded /bin/zsh would print nothing of this), and `-l`
    // reached it (the argv half). `-l` is what makes the window's PATH and
    // prompt the ones the user has everywhere else.
    const { stdout, status } = runScript({ ...process.env, SHELL: stub });
    expect(status).toBe(0);
    const [flag, pwd] = stdout.split('|');
    expect(flag).toBe('-l');
    // `realpath` because macOS resolves /var → /private/var under tmpdir().
    expect(pwd).toBe(
      spawnSync('/bin/sh', ['-c', `cd ${dir} && pwd`], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
  });

  it('enters a folder whose name a shell would otherwise split or expand', async () => {
    // A project folder is user-chosen, so spaces and shell metacharacters are
    // ordinary input. Unquoted, `cd` gets several arguments and the script
    // exits 1 before the shell is ever reached.
    const dir = mkdtempSync(join(tmpdir(), 'open terminal $odd-'));
    const stub = shellStub(dir);

    await openTerminalAt({ cwd: dir });

    const { stdout, status } = runScript({ ...process.env, SHELL: stub });
    expect(status).toBe(0);
    expect(stdout.split('|')[1]).toBe(
      spawnSync('/bin/sh', ['-c', `cd '${dir}' && pwd`], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
  });

  it('falls back to a real shell when the terminal sets no SHELL', async () => {
    // The one claim here that a run cannot make: executing the fallback would
    // mean starting the machine's own login zsh, which sources the user's
    // profile and reads stdin — nondeterministic in a suite. So this asserts
    // the DEFAULT is present in the expansion, which still fails the moment
    // someone writes a bare `exec "$SHELL" -l`: with SHELL unset that script
    // execs nothing and the window dies at a prompt-less shell.
    await openTerminalAt({ cwd: tmpdir() });

    expect(readFileSync(scriptPath(), 'utf8')).toContain('${SHELL:-/bin/zsh}');
  });

  it('carries no command, no argv and no env — only the cd', async () => {
    // The reason this is a channel of its own rather than `openInTerminal`
    // with an optional command: nothing a caller supplies reaches the script
    // except the directory, so there is no second slot to smuggle a program
    // into. `export` would be the trace of an env block; `exec` appears once,
    // for the shell itself.
    await openTerminalAt({ cwd: tmpdir() });

    const script = readFileSync(scriptPath(), 'utf8');
    expect(script).not.toContain('export');
    expect(script.match(/^exec /gm)).toHaveLength(1);
  });

  it('writes the script owner-only', async () => {
    // Same rule as the handoff's: it is executable and it names the folder the
    // agent works in, so it must not be readable by other users of a shared
    // temp dir.
    await openTerminalAt({ cwd: tmpdir() });

    expect(statSync(scriptPath()).mode & 0o777).toBe(0o700);
  });

  it('refuses off darwin rather than writing a script nothing will open', async () => {
    // The guard lives in the shared helper, so this path has it without
    // restating it — and this is the assertion that would fail if a later
    // refactor moved it back into `openInTerminal` alone.
    setPlatform('linux');
    try {
      await expect(openTerminalAt({ cwd: tmpdir() })).rejects.toThrow(
        /macOS-only/,
      );
      expect(mocks.openedWith).toHaveLength(0);
    } finally {
      setPlatform('darwin');
    }
  });
});
