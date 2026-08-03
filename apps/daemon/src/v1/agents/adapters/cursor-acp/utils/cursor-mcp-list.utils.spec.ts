import { describe, expect, it } from 'vitest';

import { parseCursorMcpList } from './cursor-mcp-list.utils';

/**
 * Verbatim `cursor-agent mcp list` output, 2026.07.23-e383d2b. Captured by
 * writing a `.cursor/mcp.json`, approving the servers with `mcp enable`, and
 * running the real binary — NOT hand-typed. Checked with `cat -A`, so a
 * trailing space or an ANSI escape could not have hidden in it: there are
 * none, and the CLI prints no health-check header either.
 */
const REAL_MIXED_OUTPUT = [
  'probe-good: ready',
  'probe-broken: Error: Connection failed',
  'probe-http: Error: Connection failed',
  '',
].join('\n');

/** Verbatim output before the servers were approved, same CLI version. */
const REAL_PENDING_OUTPUT = [
  'probe-good: not loaded (needs approval)',
  'probe-broken: not loaded (needs approval)',
  '',
].join('\n');

/** Verbatim output when neither mcp.json configures anything. */
const REAL_EMPTY_OUTPUT =
  'No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n';

describe('parseCursorMcpList', () => {
  it('reads a healthy server', () => {
    const [server] = parseCursorMcpList(REAL_MIXED_OUTPUT);

    expect(server).toEqual({
      name: 'probe-good',
      target: null,
      transport: null,
      status: 'connected',
      detail: null,
    });
  });

  it('reads a failure and keeps the CLI’s reason as the detail', () => {
    const failed = parseCursorMcpList(REAL_MIXED_OUTPUT).find(
      (server) => server.name === 'probe-broken',
    );

    expect(failed?.status).toBe('failed');
    // Coarse, but it is the whole of what the CLI gives — a bare "failed"
    // would drop the only part of a failure the user can act on.
    expect(failed?.detail).toBe('Connection failed');
  });

  it('reports a null target and transport on EVERY row', () => {
    // The reason both fields are nullable. This CLI prints neither for any
    // server, so a row carrying either would be stating something it was never
    // told — and an empty string would have claimed a command exists.
    const servers = parseCursorMcpList(REAL_MIXED_OUTPUT);

    expect(servers).toHaveLength(3);
    for (const server of servers) {
      expect(server.target).toBeNull();
      expect(server.transport).toBeNull();
    }
  });

  it('reads unapproved servers as pending, with the CLI’s hint', () => {
    const servers = parseCursorMcpList(REAL_PENDING_OUTPUT);

    expect(servers.map((server) => server.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(servers[0]?.detail).toBe('(needs approval)');
  });

  it('returns nothing for the empty-folder sentence', () => {
    // Prose, not a row. It carries no `': '` at all, but the status check is
    // what would reject it even if it did — listing it would show a server
    // called "No MCP servers configured" in the one surface whose job is to
    // state what the user actually configured.
    expect(parseCursorMcpList(REAL_EMPTY_OUTPUT)).toEqual([]);
  });

  it('returns nothing when the command produced no output at all', () => {
    // null is the adapter's spawn-failure signal (missing binary, timeout).
    expect(parseCursorMcpList(null)).toEqual([]);
    expect(parseCursorMcpList('')).toEqual([]);
  });

  it('keeps a server whose OWN NAME contains the delimiter', () => {
    // VERBATIM from the real CLI, driven with a `.cursor/mcp.json` entry named
    // `weird: name`. Splitting on the FIRST `': '` names this server "weird"
    // and reads its status as "name: not loaded (needs approval)" — an unknown
    // status, which this parser drops, so the row would vanish entirely.
    const [server] = parseCursorMcpList(
      'weird: name: not loaded (needs approval)',
    );

    expect(server?.name).toBe('weird: name');
    expect(server?.status).toBe('pending');
  });

  it('does not mistake the reason’s own colon for the delimiter', () => {
    // The mirror image of the case above, and why the scan cannot simply take
    // the LAST `': '`: that would name this server "user-srv: Error" and leave
    // "Connection failed" as an unrecognised status.
    const [server] = parseCursorMcpList('user-srv: Error: Connection failed');

    expect(server?.name).toBe('user-srv');
    expect(server?.status).toBe('failed');
    expect(server?.detail).toBe('Connection failed');
  });

  it('resolves a name that collides with a status word in favour of the RIGHTMOST status', () => {
    // Both readings parse; the rightmost is the CLI's, because the status is
    // always last. Left-to-right would have named this one "foo" and read
    // "Error: ready" as a failure whose reason is "ready".
    const [server] = parseCursorMcpList('foo: Error: ready');

    expect(server?.name).toBe('foo: Error');
    expect(server?.status).toBe('connected');
    expect(server?.detail).toBeNull();
  });

  it('DROPS a row whose status wording it does not recognise', () => {
    // The deliberate divergence from claude's parser, which keeps such a row
    // with `status: 'unknown'`. A claude row has a structural ` - ` that marks
    // it as a row regardless of its status wording; a cursor row has nothing
    // but `<name>: <status>`, so the status vocabulary IS the row test. Keeping
    // unrecognised lines would list the CLI's own prose as servers — see the
    // banner case below. The drop is not silent: zero rows without the
    // empty-folder sentence is what makes the adapter report the listing as
    // unreadable.
    expect(parseCursorMcpList('future-srv: online now')).toEqual([]);
  });

  it('does NOT list the CLI’s own prose as servers', () => {
    // The whole reason the fallback above is a drop rather than an `unknown`
    // badge: these lines are shaped exactly like server rows.
    const servers = parseCursorMcpList(
      [
        'sentry: ready',
        'Note: a new version is available: 2026.08.01',
        'Tip: run `cursor-agent upgrade` to update',
      ].join('\n'),
    );

    expect(servers.map((server) => server.name)).toEqual(['sentry']);
  });

  it('skips a line that names nothing', () => {
    expect(parseCursorMcpList('just some banner text\n\n   \n')).toEqual([]);
    expect(parseCursorMcpList(': ready')).toEqual([]);
  });

  it('never throws on hostile input', () => {
    for (const input of [
      ':::',
      '\n\n\n',
      'a: ',
      'ready',
      ': : : ready',
      'x'.repeat(10_000),
      `${'a: '.repeat(2000)}ready`,
    ]) {
      expect(() => parseCursorMcpList(input)).not.toThrow();
    }
  });

  it('yields a null detail when a failure carries no reason', () => {
    const [server] = parseCursorMcpList('bare: Error:');

    expect(server?.status).toBe('failed');
    expect(server?.detail).toBeNull();
  });

  it('does not read a longer word as a status it merely starts with', () => {
    // `readyish` starts with `ready`; without the word-boundary check it would
    // be read as a healthy server whose detail is "ish".
    expect(parseCursorMcpList('srv: readyish')).toEqual([]);
  });
});
