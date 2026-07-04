import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('terminalCommand binary override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resumes via the GENIRO_CLAUDE_BIN override path', () => {
    vi.stubEnv('GENIRO_CLAUDE_BIN', '/opt/tools/claude');
    expect(terminalCommand('claude', 'sess-42')).toEqual({
      command: '/opt/tools/claude',
      args: ['--resume', 'sess-42'],
    });
  });
});
