import { describe, expect, it } from 'vitest';

import { mcpLoginQuerySchema } from './cli-auth.dto';

describe('mcpLoginQuerySchema', () => {
  it('accepts an ordinary server name', () => {
    expect(
      mcpLoginQuerySchema.parse({
        agent: 'claude',
        cwd: '/proj',
        server: 'sentry',
      }).server,
    ).toBe('sentry');
  });

  it('rejects a server name starting with a dash', () => {
    // `server` rides straight into the sign-in argv as the CLI's LAST
    // positional argument (`AgentAdapter.runMcpLogin`) — a value beginning
    // with `-` is read there as a FLAG rather than a server name, letting a
    // caller who only holds the loopback bearer token steer the child's own
    // flags.
    expect(() =>
      mcpLoginQuerySchema.parse({
        agent: 'claude',
        cwd: '/proj',
        server: '--dangerously-skip-permissions',
      }),
    ).toThrow();
  });

  it('rejects a bare single dash', () => {
    expect(() =>
      mcpLoginQuerySchema.parse({
        agent: 'claude',
        cwd: '/proj',
        server: '-x',
      }),
    ).toThrow();
  });
});
