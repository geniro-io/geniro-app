import { describe, expect, it } from 'vitest';

import {
  addMcpServerSchema,
  copyPluginMcpServerSchema,
  listMcpServersQuerySchema,
  setMcpServerEnabledSchema,
  writeMcpConfigSchema,
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

describe('copyPluginMcpServerSchema', () => {
  const body = {
    agent: 'cursor-agent',
    cwd: '/p',
    plugin: 'datadog',
    server: 'datadog',
    variables: { DD_MCP_DOMAIN: 'mcp.datadoghq.com' },
  };

  it('accepts a plugin server with its variables', () => {
    expect(copyPluginMcpServerSchema.safeParse(body).success).toBe(true);
  });

  it('refuses a server name that would read as a flag to `mcp login`', () => {
    // The copied name is later passed to `cursor-agent mcp login <name>`.
    expect(
      copyPluginMcpServerSchema.safeParse({ ...body, server: '--help' })
        .success,
    ).toBe(false);
  });
});

describe('addMcpServerSchema', () => {
  const stdio = {
    agent: 'claude',
    name: 'acme',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/mcp'],
    env: { ACME_TOKEN: 't' },
  };
  const http = {
    agent: 'codex',
    name: 'acme',
    transport: 'http',
    url: 'https://acme.example/mcp',
    headers: { 'X-Api-Key': 'k' },
  };

  it('accepts a stdio server and an http one, defaulting the empty lists', () => {
    expect(addMcpServerSchema.parse(stdio)).toMatchObject({
      headers: {},
      args: ['-y', '@acme/mcp'],
    });
    expect(addMcpServerSchema.parse(http)).toMatchObject({ args: [], env: {} });
  });

  it.each([
    [
      'a name with a leading dash — it is `mcp add`’s positional',
      { ...stdio, name: '-rf' },
    ],
    ['a name with a space', { ...stdio, name: 'a b' }],
    ['a stdio server with no command', { ...stdio, command: ' ' }],
    ['a stdio server carrying a url', { ...stdio, url: 'https://x' }],
    ['an http server with no url', { ...http, url: undefined }],
    [
      'an http server whose url is not http(s)',
      { ...http, url: 'file:///etc/passwd' },
    ],
    ['an http server carrying a command', { ...http, command: 'npx' }],
    ['an env name a shell could not spell', { ...stdio, env: { 'A-B': '1' } }],
    [
      'a header name with a leading dash — it rides `-H` argv',
      { ...http, headers: { '-x': 'v' } },
    ],
    [
      'a header value with a newline — header injection',
      { ...http, headers: { K: 'a\r\nX: y' } },
    ],
    [
      'an argument carrying a NUL, which spawn throws on',
      { ...stdio, args: ['a\u0000b'] },
    ],
  ])('refuses %s', (_label, body) => {
    expect(addMcpServerSchema.safeParse(body).success).toBe(false);
  });
});

describe('writeMcpConfigSchema', () => {
  it('takes the whole map and the version the editor opened', () => {
    expect(
      writeMcpConfigSchema.parse({
        agent: 'cursor-agent',
        servers: { a: { command: 'x' } },
        version: null,
      }),
    ).toMatchObject({ servers: { a: { command: 'x' } }, version: null });
  });

  it('refuses a map whose entries are not objects before the service sees it', () => {
    expect(
      writeMcpConfigSchema.safeParse({
        agent: 'claude',
        servers: { a: 'npx' },
        version: null,
      }).success,
    ).toBe(false);
  });
});
