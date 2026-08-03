import { describe, expect, it } from 'vitest';

import { parseMcpList } from './claude-mcp-list.utils';

/**
 * Verbatim `claude mcp list` output, 2.1.220. Captured by adding throwaway
 * servers, running the real binary, and removing them — NOT hand-typed, which
 * matters because two status glyphs are not the characters they resemble
 * (U+221A square root, U+00D7 multiplication sign).
 */
const REAL_MIXED_OUTPUT = [
  'Checking MCP server health…',
  '',
  'probe-good: node /tmp/mcp-probe/good-server.mjs - √ Connected',
  "probe-broken: /nonexistent-binary-xyz  - × Failed to connect — ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent-binary-xyz'",
  'probe-http: https://example.invalid/mcp (HTTP) - × Failed to connect — HTTP 502: Streamable HTTP error: Error POSTing to endpoint: upstream dial failed',
  'probe-sse: https://example.invalid/sse (SSE) - × Failed to connect — HTTP 502: SSE error: Non-200 status code (502)',
  '',
].join('\n');

/** Verbatim output for an unapproved project `.mcp.json`, same CLI version. */
const REAL_PENDING_OUTPUT = [
  'Checking MCP server health…',
  '',
  'proj-pending: /bin/echo hello - ⏸ Pending approval (run `claude` to approve)',
  'proj-second: https://example.invalid/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
  '',
].join('\n');

/** Verbatim output when the folder has nothing configured. */
const REAL_EMPTY_OUTPUT =
  'No MCP servers configured. Use `claude mcp add` to add a server.\n';

describe('parseMcpList', () => {
  it('reads a connected stdio server', () => {
    const [server] = parseMcpList(REAL_MIXED_OUTPUT);

    expect(server).toEqual({
      name: 'probe-good',
      target: 'node /tmp/mcp-probe/good-server.mjs',
      transport: 'stdio',
      status: 'connected',
      detail: null,
    });
  });

  it('reads a failed server and keeps the CLI’s reason as the detail', () => {
    const failed = parseMcpList(REAL_MIXED_OUTPUT).find(
      (server) => server.name === 'probe-broken',
    );

    expect(failed?.status).toBe('failed');
    expect(failed?.target).toBe('/nonexistent-binary-xyz');
    // The reason is the whole point of surfacing a failure — a bare "failed"
    // tells the user nothing they can act on.
    expect(failed?.detail).toBe(
      "ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent-binary-xyz'",
    );
  });

  it('reads the transport off an HTTP and an SSE row, and strips it from the target', () => {
    const byName = new Map(
      parseMcpList(REAL_MIXED_OUTPUT).map((server) => [server.name, server]),
    );

    expect(byName.get('probe-http')?.transport).toBe('http');
    expect(byName.get('probe-http')?.target).toBe(
      'https://example.invalid/mcp',
    );
    expect(byName.get('probe-sse')?.transport).toBe('sse');
    expect(byName.get('probe-sse')?.target).toBe('https://example.invalid/sse');
  });

  it('drops the health-check header and blank lines rather than listing them', () => {
    // `Checking MCP server health…` has no `': '`, which is what excludes it.
    const names = parseMcpList(REAL_MIXED_OUTPUT).map((server) => server.name);

    expect(names).toEqual([
      'probe-good',
      'probe-broken',
      'probe-http',
      'probe-sse',
    ]);
  });

  it('reads unapproved project servers as pending, with the CLI’s hint', () => {
    const servers = parseMcpList(REAL_PENDING_OUTPUT);

    expect(servers.map((server) => server.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(servers[0]?.detail).toBe('(run `claude` to approve)');
    expect(servers[0]?.target).toBe('/bin/echo hello');
  });

  it('returns nothing for the empty-folder sentence', () => {
    // Prose, not a row — listing it would show a server called "No MCP servers
    // configured". Rejected for carrying no `<name>: ` delimiter at all, which
    // is an earlier guard than the row-shape check the banners hit.
    expect(parseMcpList(REAL_EMPTY_OUTPUT)).toEqual([]);
  });

  it('returns nothing when the command produced no output at all', () => {
    // null is the adapter's spawn-failure signal (missing binary, timeout).
    expect(parseMcpList(null)).toEqual([]);
    expect(parseMcpList('')).toEqual([]);
  });

  it('keeps a server whose status wording it does not recognise, as unknown', () => {
    // The version-drift guard. A future release rewording "Connected" must
    // cost the health badge, never the row — a server the user cannot see is
    // worse than one whose health is unreadable. The target must still be the
    // target: gluing the unknown wording onto the command would contradict
    // what the wire schema says that field is, and the panel shows it as the
    // server's command line.
    const servers = parseMcpList('future-srv: node server.js - ✅ Online now');

    expect(servers).toEqual([
      {
        name: 'future-srv',
        target: 'node server.js',
        transport: 'stdio',
        status: 'unknown',
        detail: '✅ Online now',
      },
    ]);
  });

  it('does NOT list the CLI’s own prose as servers', () => {
    // claude prints update banners on stdout — `agent-version.ts` works around
    // the same thing. Without the row-shape check these become servers named
    // "Note" and "Tip" in the one surface whose job is to state what the user
    // actually configured.
    const servers = parseMcpList(
      [
        'Checking MCP server health…',
        '',
        'sentry: node s.js - √ Connected',
        'Note: a new version is available: 2.2.0',
        'Tip: run `claude update` to upgrade',
      ].join('\n'),
    );

    expect(servers.map((server) => server.name)).toEqual(['sentry']);
  });

  it('does not split the row on a separator inside the server’s own command', () => {
    // ` - ` is legal inside an argument, so the split must anchor on the
    // status marker and walk back — not take the first (or last) ` - ` blindly.
    const [server] = parseMcpList(
      'weird: /bin/echo a - b --flag - √ Connected',
    );

    expect(server?.target).toBe('/bin/echo a - b --flag');
    expect(server?.status).toBe('connected');
  });

  it('skips a line that names nothing', () => {
    expect(parseMcpList('just some banner text\n\n   \n')).toEqual([]);
    expect(parseMcpList(': orphaned value - √ Connected')).toEqual([]);
  });

  it('keeps a row whose command contains the separator AND an unknown status', () => {
    // The two forgiving paths crossing: walk-back must not fire (no marker),
    // and the last-separator fallback must not eat the command's own ` - `.
    const [server] = parseMcpList('srv: /bin/x --a - --b - ✅ Fine');

    expect(server?.target).toBe('/bin/x --a - --b');
    expect(server?.detail).toBe('✅ Fine');
  });

  it('never throws on hostile input', () => {
    for (const input of [
      ':::',
      '\n\n\n',
      'a: ',
      '√ Connected',
      'x'.repeat(10_000),
      'name: - × Failed to connect —',
    ]) {
      expect(() => parseMcpList(input)).not.toThrow();
    }
  });

  it('yields a null detail when a failure carries no reason', () => {
    const [server] = parseMcpList('bare: node s.js - × Failed to connect');

    expect(server?.status).toBe('failed');
    expect(server?.detail).toBeNull();
  });
});
