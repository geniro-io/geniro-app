import { describe, expect, it } from 'vitest';

import { PUBLISHED_IDENTITIES } from './__tests__/agent-identities';
import { agentIconName, agentShortName } from './agent-identity';

describe('agentShortName', () => {
  it.each([
    { kind: 'claude', name: 'Claude' },
    { kind: 'cursor-agent', name: 'Cursor' },
    { kind: 'codex', name: 'Codex' },
  ] as const)(
    'calls $kind by the short name the daemon published',
    ({ kind, name }) => {
      expect(agentShortName(PUBLISHED_IDENTITIES, kind)).toBe(name);
    },
  );

  it('falls back to the kind before capabilities have loaded', () => {
    expect(agentShortName([], 'cursor-agent')).toBe('cursor-agent');
  });

  it('falls back to the kind for one the daemon did not report', () => {
    expect(agentShortName(PUBLISHED_IDENTITIES, 'gemini')).toBe('gemini');
  });
});

describe('agentIconName', () => {
  it.each([
    { kind: 'claude', icon: 'bot' },
    { kind: 'cursor-agent', icon: 'terminal' },
    { kind: 'codex', icon: 'code' },
  ] as const)(
    'draws $kind with the glyph the daemon published for it',
    ({ kind, icon }) => {
      expect(agentIconName(PUBLISHED_IDENTITIES, kind)).toBe(icon);
    },
  );

  it('falls back to the generic glyph before capabilities have loaded', () => {
    expect(agentIconName([], 'codex')).toBe('bot');
  });

  it('falls back to the generic glyph for a kind the daemon did not report', () => {
    expect(agentIconName(PUBLISHED_IDENTITIES, 'gemini')).toBe('bot');
  });
});
