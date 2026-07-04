import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentBinary } from './agent-binary';

describe('resolveAgentBinary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the bare binary name when no override is set', () => {
    vi.stubEnv('GENIRO_CLAUDE_BIN', '');
    vi.stubEnv('GENIRO_CURSOR_BIN', '');
    expect(resolveAgentBinary('claude')).toBe('claude');
    expect(resolveAgentBinary('cursor-agent')).toBe('cursor-agent');
  });

  it('returns the per-kind override path when set', () => {
    vi.stubEnv('GENIRO_CLAUDE_BIN', '/opt/tools/claude');
    vi.stubEnv('GENIRO_CURSOR_BIN', '/opt/tools/cursor-agent');
    expect(resolveAgentBinary('claude')).toBe('/opt/tools/claude');
    expect(resolveAgentBinary('cursor-agent')).toBe('/opt/tools/cursor-agent');
  });

  it('never crosses overrides between kinds and ignores blank values', () => {
    vi.stubEnv('GENIRO_CLAUDE_BIN', '/opt/tools/claude');
    vi.stubEnv('GENIRO_CURSOR_BIN', '   ');
    expect(resolveAgentBinary('cursor-agent')).toBe('cursor-agent');
    expect(resolveAgentBinary('claude')).toBe('/opt/tools/claude');
  });
});
