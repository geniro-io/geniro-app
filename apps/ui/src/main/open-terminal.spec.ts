import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
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

const { openInTerminal } = await import('./open-terminal');

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
function runScript(): { stdout: string; status: number | null } {
  const result = spawnSync('/bin/sh', [scriptPath()], { encoding: 'utf8' });
  return { stdout: result.stdout, status: result.status };
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
