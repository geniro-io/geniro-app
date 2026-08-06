import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentMcpServer } from '../adapters/adapter.types';
import { harvestKey } from './harvest-store';
import { McpHarvestStore } from './mcp-harvest.store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-harvest-'));
  dirs.push(dir);
  return join(dir, 'mcp-harvest.json');
}

const server = (
  name: string,
  overrides: Partial<AgentMcpServer> = {},
): AgentMcpServer => ({
  name,
  target: null,
  transport: null,
  status: 'connected',
  detail: null,
  ...overrides,
});

describe('McpHarvestStore', () => {
  it('records and returns a per-agent, per-cwd set', () => {
    const store = new McpHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [server('codegraph')]);

    expect(store.get('claude', '/proj', null)).toEqual([server('codegraph')]);
    expect(store.get('claude', '/other', null)).toBeNull();
    // One folder is routinely used by both CLIs, and neither loads the other's
    // servers — keying loosely would serve claude's set for a cursor node.
    expect(store.get('cursor-agent', '/proj', null)).toBeNull();
  });

  it('stops serving a harvest once it has aged out, so the CLI is reached again', () => {
    // Unbounded, this store does not cache — it SHADOWS. It is consulted ahead
    // of the live listing, so once any turn has run in a folder the re-dial
    // below it is never reached again, and a server the user adds to
    // `.mcp.json` never appears until they run another turn or press
    // Reconnect. The disk file makes that outlive restarts.
    let clock = 1_000_000;
    const store = new McpHarvestStore({
      file: cacheFile(),
      now: () => clock,
    });
    store.record('claude', '/proj', null, [server('codegraph')]);

    clock += 10 * 60 * 1000 - 1;
    expect(store.get('claude', '/proj', null)).toEqual([server('codegraph')]);

    clock += 1;
    expect(store.get('claude', '/proj', null)).toBeNull();
  });

  it('re-arms the window when a later turn harvests the folder again', () => {
    // The age is of the READING, not of the key: a folder in active use keeps
    // answering instantly, which is the whole reason to have a harvest.
    let clock = 1_000_000;
    const store = new McpHarvestStore({
      file: cacheFile(),
      now: () => clock,
    });
    store.record('claude', '/proj', null, [server('codegraph')]);

    clock += 9 * 60 * 1000;
    store.record('claude', '/proj', null, [server('linear')]);
    clock += 9 * 60 * 1000;

    // 18 minutes after the first harvest, and still served.
    expect(store.get('claude', '/proj', null)).toEqual([server('linear')]);
  });

  it('keys by plugin directory, because a plugin ships its own servers', () => {
    // The failure this prevents: two agent nodes on one CLI in one folder,
    // pointed at different plugin directories, genuinely load different sets.
    // Filing both under the folder alone serves each the other's answer.
    const store = new McpHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', '/plugins/a', [server('from-a')]);

    expect(store.get('claude', '/proj', '/plugins/b')).toBeNull();
    expect(store.get('claude', '/proj', null)).toBeNull();
    expect(store.get('claude', '/proj', '/plugins/a')).toEqual([
      server('from-a'),
    ]);
  });

  it('treats an empty report as a no-op, keeping the last harvest', () => {
    // A turn that reported nothing says nothing about the folder. Letting it
    // clear a good harvest would trade a real answer for a cold re-dial.
    const store = new McpHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [server('codegraph')]);
    store.record('claude', '/proj', null, []);

    expect(store.get('claude', '/proj', null)).toEqual([server('codegraph')]);
  });

  it('de-dupes by name, first occurrence winning', () => {
    const store = new McpHarvestStore({ file: cacheFile() });
    store.record('claude', '/proj', null, [
      server('dupe', { status: 'connected' }),
      server(' dupe ', { status: 'failed' }),
      server('', { status: 'failed' }),
      server('other'),
    ]);

    expect(store.get('claude', '/proj', null)).toEqual([
      server('dupe'),
      server('other'),
    ]);
  });

  it('persists across store instances via the cache file', () => {
    const file = cacheFile();
    new McpHarvestStore({ file }).record('claude', '/proj', null, [
      server('codegraph', { status: 'pending' }),
    ]);

    expect(new McpHarvestStore({ file }).get('claude', '/proj', null)).toEqual([
      server('codegraph', { status: 'pending' }),
    ]);
  });

  it('drops a record whose rows are not servers, keeping well-formed ones', () => {
    // Per-subclass load validation is what stops a cache written by an older
    // shape surfacing as a half-populated listing in the panel.
    const file = cacheFile();
    // The production key builder, not a re-spelling of it: this test is
    // about load VALIDATION, and a hand-written separator would make it
    // fail for the wrong reason the day the key gains a dimension. The
    // key's own shape is pinned by the record/get tests above.
    const key = (cwd: string): string => harvestKey('claude', cwd, '');
    writeFileSync(
      file,
      JSON.stringify({
        [key('/good')]: { entries: [server('ok')], harvestedAt: 1 },
        [key('/bad-status')]: {
          entries: [{ ...server('x'), status: 'wat' }],
          harvestedAt: 1,
        },
        [key('/bad-row')]: { entries: ['just-a-name'], harvestedAt: 1 },
      }),
      'utf8',
    );
    // A clock that makes the fixture's `harvestedAt: 1` freshly harvested, so
    // this stays a test about load VALIDATION rather than about the age bound.
    const store = new McpHarvestStore({ file, now: () => 1 });

    expect(store.get('claude', '/good', null)).toEqual([server('ok')]);
    expect(store.get('claude', '/bad-status', null)).toBeNull();
    expect(store.get('claude', '/bad-row', null)).toBeNull();
  });

  it('starts empty on a malformed cache file and can record over it', () => {
    const file = cacheFile();
    writeFileSync(file, 'not json{', 'utf8');
    const store = new McpHarvestStore({ file });

    expect(store.get('claude', '/proj', null)).toBeNull();
    store.record('claude', '/proj', null, [server('codegraph')]);
    expect(new McpHarvestStore({ file }).get('claude', '/proj', null)).toEqual([
      server('codegraph'),
    ]);
  });
});
