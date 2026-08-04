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
    // Prose, not a row — and the ONLY thing keeping it out is that it carries
    // no `': '` anywhere, now that an unrecognised status no longer drops a
    // line. Listing it would show a server called "No MCP servers configured"
    // in the one surface whose job is to state what the user configured.
    expect(REAL_EMPTY_OUTPUT).not.toContain(': ');
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
    // and reads its status as "name: not loaded (needs approval)" — which no
    // status word matches, so the row would be listed under the wrong name
    // wearing an `unknown` badge instead of the pending one it earned.
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
    //
    // Asserted as the WHOLE result, not `[0]`: one input line must yield one
    // row. Reading `[0]` alone would pass on any implementation that also
    // emitted the leftmost reading beside the right one, and a listing that
    // invents a server is worse than one that mis-names it.
    expect(parseCursorMcpList('foo: Error: ready')).toEqual([
      {
        name: 'foo: Error',
        target: null,
        transport: null,
        status: 'connected',
        detail: null,
      },
    ]);
  });

  it('reads a server switched off with `mcp disable`', () => {
    // VERBATIM from the real CLI after `cursor-agent mcp disable probe-http`.
    // Reachable by the only mechanism cursor offers for switching a server
    // off, so it is routine — and before it was modelled, this row was dropped
    // and the server silently vanished from the panel.
    const [server] = parseCursorMcpList('probe-http: disabled');

    expect(server?.name).toBe('probe-http');
    expect(server?.status).toBe('disabled');
    expect(server?.detail).toBeNull();
  });

  it('KEEPS a row whose status wording it does not recognise, as unknown', () => {
    // The version-drift guard, and the same rule claude's parser follows. A
    // drop would be undetectable whenever SOME rows still parse: the caller
    // can only tell that a listing was unreadable when EVERY row drops, so a
    // partly-reworded release would return the rows it understood and silently
    // deny the rest. That is the one outcome this surface must never produce.
    const [server] = parseCursorMcpList('future-srv: online now');

    expect(server?.name).toBe('future-srv');
    expect(server?.status).toBe('unknown');
    expect(server?.detail).toBe('online now');
  });

  it('never silently omits a row it could not read from a listing it CAN read', () => {
    // The concrete shape of the case above, and the reason it is not merely
    // theoretical: one unfamiliar status among familiar ones.
    const names = parseCursorMcpList(
      'linear: ready\nsentry: whatever-comes-next\n',
    ).map((server) => server.name);

    expect(names).toEqual(['linear', 'sentry']);
  });

  it('accepts the cost of that rule: prose shaped like a row IS listed', () => {
    // Stated as a test rather than left as a surprise. A cursor row carries no
    // structural marker — unlike claude's ` - ` — so a banner is indistinguish-
    // able from a server row, and keeping unreadable rows means keeping this
    // too. A visible bogus row beats an invisible missing one; if cursor ever
    // does print banners here, the fix is to recognise THEM, not to start
    // dropping servers again.
    const servers = parseCursorMcpList(
      ['sentry: ready', 'Note: a new version is available: 2026.08.01'].join(
        '\n',
      ),
    );

    expect(servers.map((server) => server.name)).toEqual(['sentry', 'Note']);
    expect(servers[1]?.status).toBe('unknown');
  });

  it('skips a line that names nothing', () => {
    expect(parseCursorMcpList('just some banner text\n\n   \n')).toEqual([]);
    expect(parseCursorMcpList(': ready')).toEqual([]);
  });

  it('reads a CRLF stream', () => {
    // The `.trim()` on each line is the only thing standing between a CRLF
    // stream and a total listing failure: an untrimmed `\r` rides into the
    // status match and every row fails it.
    const servers = parseCursorMcpList(
      'probe-good: ready\r\nprobe-broken: Error: Connection failed\r\n',
    );

    expect(servers.map((server) => server.status)).toEqual([
      'connected',
      'failed',
    ]);
    expect(servers[1]?.detail).toBe('Connection failed');
  });

  it('reads a column-aligned row', () => {
    // A release that pads for alignment must not cost the whole listing.
    expect(parseCursorMcpList('srv:   ready')[0]?.status).toBe('connected');
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
    // be read as a HEALTHY server whose detail is "ish". It is still listed —
    // with its health unstated, which is the honest answer.
    const [server] = parseCursorMcpList('srv: readyish');

    expect(server?.status).toBe('unknown');
    expect(server?.detail).toBe('readyish');
  });
});
