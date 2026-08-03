import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import { McpSettingsStore } from './mcp-settings.store';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-settings-'));
  file = join(dir, 'mcp-settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = (): McpSettingsStore => new McpSettingsStore({ file });

/** The file's parsed contents, as another daemon launch would read them. */
async function onDisk(): Promise<Record<string, string[]>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, string[]>;
}

describe('McpSettingsStore', () => {
  it('reports nothing disabled before anything is written', async () => {
    expect(store().disabled(AgentKind.Claude, '/proj')).toEqual([]);
  });

  it('round-trips a disabled server to a fresh instance', async () => {
    // A new instance is what a daemon restart looks like — an in-memory-only
    // toggle would pass a same-instance read and lose the setting on relaunch.
    await store().setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect(store().disabled(AgentKind.Claude, '/proj')).toEqual(['sentry']);
  });

  it('re-enabling removes the name', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', false);

    expect(store().disabled(AgentKind.Claude, '/proj')).toEqual([]);
  });

  it('keeps one folder’s toggles out of another’s', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj-a', 'sentry', true);

    expect(s.disabled(AgentKind.Claude, '/proj-b')).toEqual([]);
  });

  it('keeps one agent’s toggles out of the other’s in the same folder', async () => {
    // One folder is routinely used by both CLIs and their server sets are
    // unrelated; keying loosely would switch off a server for an agent the
    // user never touched.
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect(s.disabled(AgentKind.CursorAgent, '/proj')).toEqual([]);
  });

  it('preserves keys it does not own when writing another', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj-a', 'alpha', true);
    await s.setDisabled(AgentKind.Claude, '/proj-b', 'beta', true);

    expect(s.disabled(AgentKind.Claude, '/proj-a')).toEqual(['alpha']);
    expect(Object.keys(await onDisk())).toHaveLength(2);
  });

  it('does not duplicate a server disabled twice', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect(s.disabled(AgentKind.Claude, '/proj')).toEqual(['sentry']);
  });

  it('re-enabling a server that was never disabled is a no-op', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'never-set', false);

    expect(s.disabled(AgentKind.Claude, '/proj')).toEqual([]);
  });

  it('drops the key entirely once its last server is re-enabled', async () => {
    // Keeps the file from accumulating an empty entry per folder the user
    // ever toggled in and then undid.
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', false);

    expect(await onDisk()).toEqual({});
  });

  it('returns the set that actually landed, not the one asked for', async () => {
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'alpha', true);
    const landed = await s.setDisabled(AgentKind.Claude, '/proj', 'beta', true);

    expect(landed).toEqual(['alpha', 'beta']);
  });

  it('degrades to nothing-disabled on a malformed file', async () => {
    // Risk 3 of the milestone: a broken settings file must not fail a turn.
    await writeFile(file, '{ this is not json', 'utf8');

    expect(store().disabled(AgentKind.Claude, '/proj')).toEqual([]);
  });

  it('keeps the well-formed keys when one entry is corrupt', async () => {
    // Per-entry validation, not per-file: one bad key must not discard every
    // other folder's toggles. The keys come from a file the store itself
    // wrote, so this drives the REAL key shape rather than one the spec
    // invented — a spec-built key would keep passing if the shape changed.
    const seed = store();
    await seed.setDisabled(AgentKind.Claude, '/good', 'alpha', true);
    await seed.setDisabled(AgentKind.Claude, '/bad', 'placeholder', true);
    await seed.setDisabled(AgentKind.Claude, '/alsobad', 'placeholder', true);
    const written = await onDisk();
    const keyFor = (cwd: string): string => {
      const key = Object.keys(written).find((k) => k.endsWith(cwd));
      if (key === undefined) {
        throw new Error(`store wrote no key for ${cwd}`);
      }
      return key;
    };
    await writeFile(
      file,
      JSON.stringify({
        [keyFor('/good')]: ['alpha'],
        [keyFor('/bad')]: { not: 'an array' },
        [keyFor('/alsobad')]: [1, 2, 3],
      }),
      'utf8',
    );
    const s = store();

    expect(s.disabled(AgentKind.Claude, '/good')).toEqual(['alpha']);
    expect(s.disabled(AgentKind.Claude, '/bad')).toEqual([]);
    expect(s.disabled(AgentKind.Claude, '/alsobad')).toEqual([]);
  });

  it('repairs a corrupt file on the next write instead of needing a migration', async () => {
    await writeFile(file, 'garbage', 'utf8');
    const s = store();
    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect(Object.values(await onDisk())).toEqual([['sentry']]);
    expect(store().disabled(AgentKind.Claude, '/proj')).toEqual(['sentry']);
  });

  it('leaves no staging file beside the store', async () => {
    // The write is atomic (tmp + rename); a stray tmp would be a second file
    // in the userData dir that nothing ever cleans up.
    await store().setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('serves the toggle for this session even when the disk write fails', async () => {
    // Losing the setting on restart is recoverable; dropping the user's click
    // on the floor while the app is still open is not. The failure is real
    // rather than mocked: a regular file sits where the store wants a
    // directory, so mkdir fails with ENOTDIR.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, '', 'utf8');
    const s = new McpSettingsStore({
      file: join(blocker, 'nested/store.json'),
    });

    await s.setDisabled(AgentKind.Claude, '/proj', 'sentry', true);

    expect(s.disabled(AgentKind.Claude, '/proj')).toEqual(['sentry']);
  });

  it('refuses past the cap instead of silently dropping the request', async () => {
    // Truncating would discard the tail — the name just clicked — and still
    // report success, so the switch would move and the next turn would load
    // the server anyway. That is the silent no-op the whole design forbids.
    const s = store();
    for (let i = 0; i < 200; i += 1) {
      await s.setDisabled(AgentKind.Claude, '/proj', `srv-${i}`, true);
    }

    await expect(
      s.setDisabled(AgentKind.Claude, '/proj', 'one-too-many', true),
    ).rejects.toThrow();
    expect(s.disabled(AgentKind.Claude, '/proj')).toHaveLength(200);
    expect(s.disabled(AgentKind.Claude, '/proj')).not.toContain('one-too-many');
  });

  it('caps a hand-written file that is already over the limit', async () => {
    // The load path's own slice, which the write path can no longer reach now
    // that it refuses rather than truncating.
    const seed = store();
    await seed.setDisabled(AgentKind.Claude, '/proj', 'seed', true);
    const key = Object.keys(await onDisk())[0]!;
    await writeFile(
      file,
      JSON.stringify({
        [key]: Array.from({ length: 300 }, (_, i) => `srv-${i}`),
      }),
      'utf8',
    );

    expect(store().disabled(AgentKind.Claude, '/proj')).toHaveLength(200);
  });
});
