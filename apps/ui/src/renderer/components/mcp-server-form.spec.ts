import { describe, expect, it } from 'vitest';

import {
  EMPTY_MCP_SERVER_FORM,
  formatMcpServersJson,
  readMcpServerForm,
  readMcpServersJson,
} from './mcp-server-form';

describe('readMcpServerForm', () => {
  const form = (patch: Partial<typeof EMPTY_MCP_SERVER_FORM>) => ({
    ...EMPTY_MCP_SERVER_FORM,
    ...patch,
  });

  it('reads a stdio server: each argument line kept whole, env split at the first =', () => {
    expect(
      readMcpServerForm(
        form({
          name: ' acme ',
          command: 'npx',
          args: '-y\n\n@acme/mcp server\r\n',
          env: 'A=1\nB=x=y',
        }),
      ),
    ).toEqual({
      ok: true,
      server: {
        name: 'acme',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/mcp server'],
        env: { A: '1', B: 'x=y' },
      },
    });
  });

  it('reads an http server with headers split at the first colon', () => {
    expect(
      readMcpServerForm(
        form({
          name: 'acme',
          transport: 'http',
          url: 'https://acme/mcp',
          headers: 'Authorization: Bearer a:b',
        }),
      ),
    ).toEqual({
      ok: true,
      server: {
        name: 'acme',
        transport: 'http',
        url: 'https://acme/mcp',
        headers: { Authorization: 'Bearer a:b' },
      },
    });
  });

  it.each([
    ['no name', form({ command: 'x' })],
    ['a name with a space', form({ name: 'a b', command: 'x' })],
    ['a name with a leading dash', form({ name: '-a', command: 'x' })],
    ['no command', form({ name: 'a' })],
    ['an env line without =', form({ name: 'a', command: 'x', env: 'TOKEN' })],
    [
      'an env name a shell cannot spell',
      form({ name: 'a', command: 'x', env: 'A-B=1' }),
    ],
    [
      'a url that is not http(s)',
      form({ name: 'a', transport: 'http', url: 'ftp://x' }),
    ],
    [
      'a header line without :',
      form({ name: 'a', transport: 'http', url: 'https://x', headers: 'X' }),
    ],
  ])('refuses %s', (_label, values) => {
    expect(readMcpServerForm(values).ok).toBe(false);
  });
});

describe('readMcpServersJson', () => {
  it('round-trips what the editor shows', () => {
    const servers = {
      a: { command: 'x', args: ['y'] },
      b: { url: 'https://z' },
    };
    expect(readMcpServersJson(formatMcpServersJson(servers))).toEqual({
      ok: true,
      servers,
    });
  });

  it.each([
    ['broken JSON', '{', /Not valid JSON/],
    ['an array', '[]', /one JSON object/],
    ['an entry that is not an object', '{"a": "npx"}', /must be an object/],
    [
      'an entry with neither command nor url',
      '{"a": {"args": []}}',
      /needs a "command"/,
    ],
  ])('refuses %s', (_label, text, reason) => {
    const checked = readMcpServersJson(text);
    expect(checked.ok ? '' : checked.reason).toMatch(reason);
  });
});
