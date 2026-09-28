import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_PATHS_ENV, resolveAgentBinary } from './agent-binary';

describe('resolveAgentBinary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the bare binary name when no override is set', () => {
    vi.stubEnv(CLI_PATHS_ENV, '');
    expect(resolveAgentBinary('claude')).toBe('claude');
    expect(resolveAgentBinary('cursor-agent')).toBe('cursor-agent');
  });

  it('returns the per-kind override path when set', () => {
    vi.stubEnv(
      CLI_PATHS_ENV,
      JSON.stringify({
        claude: '/opt/tools/claude',
        'cursor-agent': '/opt/tools/cursor-agent',
      }),
    );
    expect(resolveAgentBinary('claude')).toBe('/opt/tools/claude');
    expect(resolveAgentBinary('cursor-agent')).toBe('/opt/tools/cursor-agent');
  });

  it('never crosses overrides between kinds and ignores blank values', () => {
    vi.stubEnv(
      CLI_PATHS_ENV,
      JSON.stringify({ claude: '/opt/tools/claude', 'cursor-agent': '   ' }),
    );
    expect(resolveAgentBinary('cursor-agent')).toBe('cursor-agent');
    expect(resolveAgentBinary('claude')).toBe('/opt/tools/claude');
  });

  it('reads a malformed map as no override rather than throwing', () => {
    vi.stubEnv(CLI_PATHS_ENV, '{not json');
    expect(resolveAgentBinary('claude')).toBe('claude');
    vi.stubEnv(CLI_PATHS_ENV, JSON.stringify(['/opt/tools/claude']));
    expect(resolveAgentBinary('claude')).toBe('claude');
    vi.stubEnv(CLI_PATHS_ENV, JSON.stringify({ claude: 42 }));
    expect(resolveAgentBinary('claude')).toBe('claude');
  });
});
