import { describe, expect, it } from 'vitest';

import {
  parseDisabledServerNames,
  parseProjectServerNames,
} from './claude-mcp-folder.utils';

describe('parseProjectServerNames', () => {
  it('reads the names under mcpServers', () => {
    // The shape a real project `.mcp.json` carries — the same one the probe
    // fixtures used to make servers appear in a turn.
    const source = JSON.stringify({
      mcpServers: {
        sentry: { command: 'npx', args: ['-y', 'server'] },
        docs: { type: 'http', url: 'https://example.invalid/mcp' },
      },
    });

    expect(parseProjectServerNames(source)).toEqual(['sentry', 'docs']);
  });

  it('returns nothing for a file with no mcpServers key', () => {
    expect(parseProjectServerNames(JSON.stringify({ other: 1 }))).toEqual([]);
  });

  it('returns nothing rather than throwing on malformed JSON', () => {
    // These are the user's files. A stray comma must not break the listing.
    expect(parseProjectServerNames('{ nope')).toEqual([]);
  });

  it('returns nothing when mcpServers is an array rather than an object', () => {
    // `Object.keys` on an array yields indices — "0", "1" — which would be
    // rendered as project-scope server NAMES and given switches.
    expect(
      parseProjectServerNames(JSON.stringify({ mcpServers: ['a', 'b'] })),
    ).toEqual([]);
  });

  it('returns nothing when mcpServers is null', () => {
    expect(
      parseProjectServerNames(JSON.stringify({ mcpServers: null })),
    ).toEqual([]);
  });

  it('returns nothing for a JSON scalar', () => {
    expect(parseProjectServerNames('42')).toEqual([]);
    expect(parseProjectServerNames('null')).toEqual([]);
    expect(parseProjectServerNames('"a string"')).toEqual([]);
  });

  it('reports an empty mcpServers object as no servers', () => {
    expect(parseProjectServerNames(JSON.stringify({ mcpServers: {} }))).toEqual(
      [],
    );
  });
});

describe('parseDisabledServerNames', () => {
  it('reads disabledMcpjsonServers', () => {
    const source = JSON.stringify({ disabledMcpjsonServers: ['sentry'] });

    expect(parseDisabledServerNames(source)).toEqual(['sentry']);
  });

  it('returns nothing when the key is absent', () => {
    expect(
      parseDisabledServerNames(JSON.stringify({ permissions: {} })),
    ).toEqual([]);
  });

  it('returns nothing rather than throwing on malformed JSON', () => {
    expect(parseDisabledServerNames('not json at all')).toEqual([]);
  });

  it('keeps the string entries when the list is partly junk', () => {
    // This list decides whether a row gets a switch. Discarding the whole
    // array over one bad element would make every OTHER server the user
    // disabled look toggleable — and its switch would then silently do
    // nothing, since the CLI unions the lists.
    const source = JSON.stringify({
      disabledMcpjsonServers: ['sentry', 42, null, 'docs', { a: 1 }],
    });

    expect(parseDisabledServerNames(source)).toEqual(['sentry', 'docs']);
  });

  it('returns nothing when the key is not an array', () => {
    expect(
      parseDisabledServerNames(
        JSON.stringify({ disabledMcpjsonServers: 'sentry' }),
      ),
    ).toEqual([]);
  });
});
