import { describe, expect, it } from 'vitest';

import { terminalCommand } from './terminal-command';

describe('terminalCommand', () => {
  it('resumes the stored claude session', () => {
    expect(terminalCommand('claude', 'sess-42')).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-42'],
    });
  });

  it('opens a fresh interactive claude session without a session id', () => {
    expect(terminalCommand('claude', null)).toEqual({
      command: 'claude',
      args: [],
    });
  });

  it('rejects cursor-agent (deferred scope)', () => {
    expect(() => terminalCommand('cursor-agent', null)).toThrowError(
      /TERMINAL_UNSUPPORTED|no interactive terminal/,
    );
  });
});
