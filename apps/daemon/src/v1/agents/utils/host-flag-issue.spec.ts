import { describe, expect, it } from 'vitest';

import { isHostFlagIssueCall } from './host-flag-issue';

describe('isHostFlagIssueCall', () => {
  const server = 'geniro-12345678';

  it('approves flag_issue on the run’s own server in both spellings', () => {
    expect(isHostFlagIssueCall(server, `mcp__${server}__flag_issue`)).toBe(
      true,
    );
    expect(
      isHostFlagIssueCall(server, `${server}-flag_issue: flag_issue`),
    ).toBe(true);
  });

  it('refuses another server, another tool and a turn granted no host tools', () => {
    expect(
      isHostFlagIssueCall(server, 'mcp__geniro-87654321__flag_issue'),
    ).toBe(false);
    expect(isHostFlagIssueCall(server, `mcp__${server}__record_outcome`)).toBe(
      false,
    );
    expect(isHostFlagIssueCall(null, `mcp__${server}__flag_issue`)).toBe(false);
  });
});
