import { describe, expect, it } from 'vitest';

import {
  checkMcpServerDefinitions,
  MAX_MCP_SERVER_DEFINITIONS,
  mcpServerJsonEntry,
  mcpServersVersion,
  readMcpServersKey,
} from './mcp-config.utils';

describe('checkMcpServerDefinitions', () => {
  it('accepts a command server and a url server, passing their own fields through', () => {
    const servers = {
      local: {
        command: 'npx',
        args: ['-y', 'x'],
        env: { A: '1' },
        type: 'stdio',
      },
      remote: {
        url: 'https://x/mcp',
        headers: { K: 'v' },
        bearer_token_env_var: 'T',
      },
    };
    expect(checkMcpServerDefinitions(servers)).toEqual({ ok: true, servers });
  });

  it.each([
    ['an array', [], /JSON object/],
    ['a string', 'servers', /JSON object/],
    ['an entry that is not an object', { a: 'npx' }, /"a" must be an object/],
    [
      'an entry with neither command nor url',
      { a: { args: [] } },
      /needs a "command" .* or a "url"/,
    ],
    [
      'args that are not strings',
      { a: { command: 'x', args: [1] } },
      /args must be a list of strings/,
    ],
    [
      'env with a non-string value',
      { a: { command: 'x', env: { A: 1 } } },
      /env must be an object of string values/,
    ],
    [
      'codex http_headers that is a list',
      { a: { url: 'https://x', http_headers: ['K'] } },
      /http_headers must be/,
    ],
    [
      'a name with a leading dash',
      { '-a': { command: 'x' } },
      /must not start with a dash/,
    ],
    [
      'a name with a control character',
      { 'a\u0007': { command: 'x' } },
      /control character/,
    ],
    ['an empty name', { '': { command: 'x' } }, /must not be empty/],
  ])('refuses %s', (_label, value, reason) => {
    const checked = checkMcpServerDefinitions(value);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? '' : checked.reason).toMatch(reason);
  });

  it('refuses a map past the cap', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_MCP_SERVER_DEFINITIONS + 1 }, (_, i) => [
        `s${i}`,
        { command: 'x' },
      ]),
    );
    expect(checkMcpServerDefinitions(many)).toMatchObject({ ok: false });
  });
});

describe('readMcpServersKey', () => {
  it('reads an absent key as an empty map — a fresh file defines none', () => {
    expect(readMcpServersKey({ other: 1 }, 'mcpServers', '/f')).toEqual({
      ok: true,
      servers: {},
    });
  });

  it('refuses a key or an entry it could not write back whole', () => {
    expect(readMcpServersKey({ mcpServers: [1] }, 'mcpServers', '/f')).toEqual({
      ok: false,
      reason:
        '/f has an mcpServers that is not an object, so geniro will not rewrite it',
    });
    expect(
      readMcpServersKey({ mcpServers: { a: 'x' } }, 'mcpServers', '/f'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/mcpServers\.a/),
    });
  });
});

describe('mcpServersVersion', () => {
  it('is equal for equal maps and moves when any entry does', () => {
    const a = { x: { command: 'a' } };
    expect(mcpServersVersion(a)).toBe(
      mcpServersVersion({ x: { command: 'a' } }),
    );
    expect(mcpServersVersion(a)).not.toBe(
      mcpServersVersion({ x: { command: 'b' } }),
    );
  });
});

describe('mcpServerJsonEntry', () => {
  it('writes command/args/env for stdio and url/headers for http, leaving empty ones out', () => {
    expect(
      mcpServerJsonEntry({
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { A: '1' },
        url: null,
        headers: {},
      }),
    ).toEqual({ command: 'npx', env: { A: '1' } });
    expect(
      mcpServerJsonEntry({
        name: 'a',
        transport: 'http',
        command: null,
        args: [],
        env: {},
        url: 'https://x',
        headers: {},
      }),
    ).toEqual({ url: 'https://x' });
  });
});
