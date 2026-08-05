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
});
