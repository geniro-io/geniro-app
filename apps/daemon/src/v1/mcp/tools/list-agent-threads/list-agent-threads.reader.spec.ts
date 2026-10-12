import { describe, expect, it } from 'vitest';

import { validateListAgentThreadsArgs } from './list-agent-threads.reader';

describe('validateListAgentThreadsArgs', () => {
  it('accepts no arguments', () => {
    expect(validateListAgentThreadsArgs({})).toBeNull();
  });

  it('refuses any argument rather than ignoring it', () => {
    expect(validateListAgentThreadsArgs({ agent: 'qa' })).toMatchObject({
      status: 'error',
      error: expect.stringContaining("unknown argument(s) 'agent'"),
    });
  });
});
