import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalCommand } from './terminal-command';

describe('terminalCommand', () => {
  it('resumes the stored claude session', () => {
    expect(terminalCommand('claude', 'sess-42')).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-42'],
    });
  });

  it('rejects claude until a resumable session id is stored', () => {
    expect(() => terminalCommand('claude', null)).toThrowError(
      /TERMINAL_SESSION_UNAVAILABLE|resumable terminal session/,
    );
  });

  it('rejects a whitespace-only session id instead of spawning a broken resume command', () => {
    expect(() => terminalCommand('claude', ' \t\n ')).toThrowError(
      /TERMINAL_SESSION_UNAVAILABLE|resumable terminal session/,
    );
  });

  it('rejects a zero-width-only session id instead of spawning an invisible resume target', () => {
    expect(() => terminalCommand('claude', '\u200b')).toThrowError(
      /TERMINAL_SESSION_UNAVAILABLE|resumable terminal session/,
    );
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
