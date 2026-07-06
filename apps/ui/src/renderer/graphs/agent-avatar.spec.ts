import { describe, expect, it } from 'vitest';

import { agentInitials } from './agent-avatar';

describe('agentInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(agentInitials('Review Team')).toBe('RT');
  });

  it('treats hyphens and underscores as word separators', () => {
    expect(agentInitials('web-researcher')).toBe('WR');
    expect(agentInitials('code_reviewer')).toBe('CR');
  });

  it('uses the first two characters of a single word', () => {
    expect(agentInitials('coder')).toBe('CO');
  });

  it('falls back to "?" for a blank label', () => {
    expect(agentInitials('   ')).toBe('?');
  });
});
