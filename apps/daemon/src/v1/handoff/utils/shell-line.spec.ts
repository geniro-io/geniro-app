import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { shellLine } from './shell-line';

describe('shellLine', () => {
  it('leaves an ordinary invocation bare, so it reads as a command', () => {
    // The whole point of the line is that a user can look at it and recognise
    // what it does. Quoting a UUID and a flag would bury that in punctuation.
    expect(shellLine('claude', ['--resume', 'a1b2-c3d4'])).toBe(
      'claude --resume a1b2-c3d4',
    );
  });

  it('quotes a path with a space, so pasting it cannot split it in two', () => {
    expect(shellLine('claude', ['--cwd', '/Users/me/My Projects/app'])).toBe(
      "claude --cwd '/Users/me/My Projects/app'",
    );
  });

  it('neutralises a shell metacharacter instead of letting it run', () => {
    // A session id or model name is agent-supplied data reaching a copyable
    // command line. Left bare, `;` and `$(…)` would execute on paste.
    expect(shellLine('claude', ['--model', 'x; rm -rf /'])).toBe(
      "claude --model 'x; rm -rf /'",
    );
    expect(shellLine('claude', ['--model', '$(whoami)'])).toBe(
      "claude --model '$(whoami)'",
    );
  });

  it('closes, escapes and reopens an embedded single quote', () => {
    // The one form that survives every POSIX shell: '\'' — a bare backslash
    // escape does nothing inside single quotes.
    expect(shellLine('claude', ["it's"])).toBe("claude 'it'\\''s'");
  });

  it('keeps an empty argument as an argument', () => {
    // Dropped to nothing, the paste would silently shift every flag after it.
    expect(shellLine('claude', ['--resume', ''])).toBe("claude --resume ''");
  });

  it('prefixes the env as assignments the pasted command actually gets', () => {
    // A prefix assignment, not an `export`: the pasted line must not leave the
    // variable set in the user's shell afterwards, silently re-pointing every
    // later CLI invocation in that window.
    expect(
      shellLine('claude', ['--resume', 'sess-1'], {
        CLAUDE_CONFIG_DIR: '/profiles/work',
      }),
    ).toBe('CLAUDE_CONFIG_DIR=/profiles/work claude --resume sess-1');
  });

  it('renders a line a real shell runs, with the env reaching the command', () => {
    // Every other case here asserts the STRING, which is what let this line's
    // Electron twin (`apps/ui/src/main/open-terminal.ts`) ship a rendering no
    // shell could run: `exec NAME=value cmd` makes the shell resolve
    // `NAME=value` as the program. Text equality cannot catch that class of
    // bug, so the twin's spec runs its script — and this side, which is meant
    // to be PASTED into a shell, gets the same treatment for the same reason.
    const line = shellLine(
      '/bin/sh',
      ['-c', 'printf %s "$CLAUDE_CONFIG_DIR"'],
      { CLAUDE_CONFIG_DIR: '/profiles/with a space' },
    );

    const run = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('/profiles/with a space');
  });

  it('quotes the VALUE of an assignment without re-quoting the assignment', () => {
    // Re-quoted as one word, the shell looks for a command literally named
    // `CLAUDE_CONFIG_DIR=/two words` and the whole line fails.
    expect(
      shellLine('claude', ['--resume', 'sess-1'], {
        CLAUDE_CONFIG_DIR: '/two words',
      }),
    ).toBe("CLAUDE_CONFIG_DIR='/two words' claude --resume sess-1");
  });

  it('renders the same line for the same env whatever order it was built in', () => {
    // An object has no order of its own; a line that reshuffles between reads
    // reads as a different command.
    expect(shellLine('claude', [], { B: '2', A: '1' })).toBe(
      shellLine('claude', [], { A: '1', B: '2' }),
    );
  });
});
