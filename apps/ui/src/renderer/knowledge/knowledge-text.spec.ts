import { describe, expect, it } from 'vitest';

import { byLine } from './knowledge-text';

const agent = { actor: 'agent', runId: 'run-1' } as const;

describe('byLine', () => {
  it('names the user', () => {
    expect(
      byLine({ actor: 'user', runId: null, agentKind: null, model: null }),
    ).toBe('You');
  });

  it('names an agent by its CLI and model', () => {
    expect(byLine({ ...agent, agentKind: 'claude', model: 'opus' })).toBe(
      'claude · opus',
    );
  });

  it('says agent once when neither the CLI nor the model is known', () => {
    expect(byLine({ ...agent, agentKind: null, model: null })).toBe('an agent');
  });

  it('keeps the model of an agent whose CLI is not known', () => {
    expect(byLine({ ...agent, agentKind: null, model: 'opus' })).toBe(
      'an agent · opus',
    );
  });

  it('marks a known CLI with no model as an agent', () => {
    expect(byLine({ ...agent, agentKind: 'codex', model: null })).toBe(
      'codex · agent',
    );
  });
});
