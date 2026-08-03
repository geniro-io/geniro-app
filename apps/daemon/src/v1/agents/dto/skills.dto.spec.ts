import { describe, expect, it } from 'vitest';

import { listMcpServersQuerySchema } from './skills.dto';

describe('listMcpServersQuerySchema', () => {
  it('reads the refresh flag out of the query STRING', () => {
    // A query param is always a string on the wire. Refresh is the only path
    // that re-dials a server that has since recovered, so if this coercion
    // regresses the button silently serves cached rows with a green suite.
    expect(
      listMcpServersQuerySchema.parse({
        agent: 'claude',
        cwd: '/p',
        refresh: 'true',
      }).refresh,
    ).toBe(true);
  });

  it('reads an explicit "false" as false, not as truthy-because-non-empty', () => {
    // The reason this is `z.stringbool()` and not `z.coerce.boolean()`: the
    // latter reads the STRING "false" as true.
    expect(
      listMcpServersQuerySchema.parse({
        agent: 'claude',
        cwd: '/p',
        refresh: 'false',
      }).refresh,
    ).toBe(false);
  });

  it('leaves refresh undefined when the caller omits it', () => {
    expect(
      listMcpServersQuerySchema.parse({ agent: 'claude', cwd: '/p' }).refresh,
    ).toBeUndefined();
  });

  it('rejects an agent kind the daemon does not know', () => {
    expect(() =>
      listMcpServersQuerySchema.parse({ agent: 'not-an-agent', cwd: '/p' }),
    ).toThrow();
  });
});
