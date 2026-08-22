import { describe, expect, it } from 'vitest';

import {
  listMcpServersQuerySchema,
  setMcpServerEnabledSchema,
} from './mcp.dto';

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

describe('setMcpServerEnabledSchema', () => {
  it('accepts a full toggle body', () => {
    expect(
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '/p',
        server: 'sentry',
        enabled: false,
      }),
    ).toEqual({
      agent: 'claude',
      cwd: '/p',
      server: 'sentry',
      enabled: false,
    });
  });

  it('requires a real boolean rather than coercing a string', () => {
    // This is a JSON body, not a query string. Coercing here would read the
    // string "false" as true and switch a server ON when the user asked to
    // switch it off — the one direction that cannot be undone by re-clicking,
    // since the CLI unions the disabled lists.
    expect(() =>
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '/p',
        server: 'sentry',
        enabled: 'false',
      }),
    ).toThrow();
  });

  it('rejects an empty server name', () => {
    expect(() =>
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '/p',
        server: '',
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects a server name starting with a dash', () => {
    // `server` rides straight into `cursor-agent mcp enable|disable <server>`
    // / `mcp list-tools <server>` as the CLI's LAST positional argument — a
    // value beginning with `-` is read there as a FLAG rather than a server
    // name, letting a caller who only holds the loopback bearer token steer
    // the child's own flags. The identical guard as `cli-auth.dto.ts`'s
    // `mcpLoginQuerySchema.server`, via the shared `cliPositionalArgSchema`.
    expect(() =>
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '/p',
        server: '--dangerously-skip-permissions',
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects a bare single dash', () => {
    expect(() =>
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '/p',
        server: '-x',
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects an empty cwd', () => {
    expect(() =>
      setMcpServerEnabledSchema.parse({
        agent: 'claude',
        cwd: '',
        server: 'sentry',
        enabled: true,
      }),
    ).toThrow();
  });
});
