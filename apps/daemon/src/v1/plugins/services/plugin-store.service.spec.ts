import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import type { PluginsChangedEvent } from '../plugins.types';
import { PluginEventBus } from './plugin-events.bus';
import { PluginStoreService } from './plugin-store.service';

const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/title' } },
];

const pluginText = (change: Record<string, unknown> = {}): string =>
  stringify({ name: 'Deploys', command: 'echo {}', view: VIEW, ...change });

describe('PluginStoreService', () => {
  let dir: string;
  let pluginsDir: string;
  let events: PluginsChangedEvent[];
  let store: PluginStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-plugins-'));
    pluginsDir = join(dir, 'plugins');
    const bus = new PluginEventBus();
    events = [];
    bus.allChanges().subscribe((event) => events.push(event));
    store = new PluginStoreService({ pluginsDir }, bus);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fileOf = (slug: string) => join(pluginsDir, `${slug}.plugin.yaml`);
  const approvedFileOf = (slug: string) =>
    join(pluginsDir, '.approved', `${slug}.plugin.yaml`);
  const backupsOf = (slug: string): Promise<string[]> =>
    readdir(join(pluginsDir, '.backups'))
      .then((names) => names.filter((name) => name.startsWith(`${slug}.`)))
      .catch(() => [] as string[]);

  it('writes an approved plugin and its approved copy', async () => {
    const text = pluginText();

    const saved = await store.write('deploys', text, { approve: true });

    expect(saved).toMatchObject({ slug: 'deploys', state: 'approved', text });
    expect(await readFile(fileOf('deploys'), 'utf8')).toBe(text);
    expect(await readFile(approvedFileOf('deploys'), 'utf8')).toBe(text);
  });

  it('writes a plugin the user has not approved as changed', async () => {
    const saved = await store.write('deploys', pluginText(), {
      approve: false,
    });

    expect(saved.state).toBe('changed');
    expect(saved.approvedText).toBeNull();
    await expect(
      readFile(approvedFileOf('deploys'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('marks an approved plugin changed when its file is edited by hand', async () => {
    const text = pluginText();
    await store.write('deploys', text, { approve: true });
    await writeFile(fileOf('deploys'), `${text}\n# edited by hand\n`);

    const stored = await store.getOrThrow('deploys');

    expect(stored.state).toBe('changed');
    expect(stored.approvedText).toBe(text);
  });

  it('approves the text the caller saw', async () => {
    const text = pluginText();
    const { hash } = await store.write('deploys', text, { approve: false });

    const approved = await store.approve('deploys', hash);

    expect(approved.state).toBe('approved');
    expect(await readFile(approvedFileOf('deploys'), 'utf8')).toBe(text);
  });

  it('refuses an approval of a text the file no longer holds with PLUGIN_CHANGED', async () => {
    const { hash } = await store.write('deploys', pluginText(), {
      approve: false,
    });
    await writeFile(fileOf('deploys'), pluginText({ command: 'echo later' }));

    await expect(store.approve('deploys', hash)).rejects.toMatchObject({
      errorCode: 'PLUGIN_CHANGED',
    });
    await expect(
      readFile(approvedFileOf('deploys'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checks the base hash of a write: a stale one is refused, a current one saves', async () => {
    const first = await store.write('deploys', pluginText(), {
      approve: false,
    });
    const second = await store.write(
      'deploys',
      pluginText({ name: 'Deploys 2' }),
      {
        baseHash: first.hash,
        approve: false,
      },
    );

    await expect(
      store.write('deploys', pluginText({ name: 'Deploys 3' }), {
        baseHash: first.hash,
        approve: false,
      }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_CHANGED' });
    expect((await store.getOrThrow('deploys')).hash).toBe(second.hash);
  });

  it('takes a null base hash as "no file yet": refused over an existing file', async () => {
    await store.write('deploys', pluginText(), {
      baseHash: null,
      approve: false,
    });

    await expect(
      store.write('deploys', pluginText({ name: 'Deploys 2' }), {
        baseHash: null,
        approve: false,
      }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_CHANGED' });
    expect(await readFile(fileOf('deploys'), 'utf8')).toBe(pluginText());
  });

  it('refuses invalid text with PLUGIN_INVALID and writes nothing', async () => {
    await expect(
      store.write('deploys', pluginText({ command: 'echo a\necho b' }), {
        approve: true,
      }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_INVALID' });

    await expect(readFile(fileOf('deploys'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(approvedFileOf('deploys'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(events).toEqual([]);
  });

  it('keeps an approved plugin approved on update and leaves a changed one changed', async () => {
    const approved = await store.write('deploys', pluginText(), {
      approve: true,
    });
    const updated = await store.update('deploys', approved.hash, (text) =>
      text.replace('Deploys', 'Deploys 2'),
    );

    expect(updated).toMatchObject({
      state: 'approved',
      text: pluginText({ name: 'Deploys 2' }),
    });
    expect(await readFile(approvedFileOf('deploys'), 'utf8')).toBe(
      updated.text,
    );

    const changed = await store.write('other', pluginText(), {
      approve: false,
    });
    const stillChanged = await store.update('other', changed.hash, (text) =>
      text.replace('Deploys', 'Other'),
    );

    expect(stillChanged.state).toBe('changed');
    expect(stillChanged.approvedText).toBeNull();
  });

  it('backs up the file before every replace, and not on the first write', async () => {
    const first = await store.write('deploys', pluginText(), { approve: true });
    expect(await backupsOf('deploys')).toEqual([]);

    const second = await store.write(
      'deploys',
      pluginText({ name: 'Deploys 2' }),
      {
        baseHash: first.hash,
        approve: true,
      },
    );
    expect(await backupsOf('deploys')).toHaveLength(1);

    await store.write('deploys', pluginText({ name: 'Deploys 3' }), {
      baseHash: second.hash,
      approve: true,
    });
    const names = await backupsOf('deploys');
    expect(names).toHaveLength(2);
    expect(
      await Promise.all(
        names.map((name) =>
          readFile(join(pluginsDir, '.backups', name), 'utf8'),
        ),
      ),
    ).toContain(pluginText());
  });

  it('keeps the newest 20 backups of a plugin and prunes only its own', async () => {
    let stored = await store.write(
      'deploys',
      pluginText({ name: 'Deploys 0' }),
      {
        approve: false,
      },
    );
    for (let i = 1; i <= 25; i += 1) {
      stored = await store.write(
        'deploys',
        pluginText({ name: `Deploys ${i}` }),
        {
          baseHash: stored.hash,
          approve: false,
        },
      );
    }
    const other = await store.write('other', pluginText(), { approve: false });
    await store.write('other', pluginText({ name: 'Other 2' }), {
      baseHash: other.hash,
      approve: false,
    });

    expect(await backupsOf('deploys')).toHaveLength(20);
    expect(await backupsOf('other')).toHaveLength(1);
  });

  it('deletes a plugin with its approved copy, backing the file up first', async () => {
    const text = pluginText();
    await store.write('deploys', text, { approve: true });

    expect(await store.delete('deploys')).toBe(true);

    await expect(readFile(fileOf('deploys'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(approvedFileOf('deploys'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const names = await backupsOf('deploys');
    expect(names).toHaveLength(1);
    expect(
      await readFile(join(pluginsDir, '.backups', names[0]!), 'utf8'),
    ).toBe(text);
    expect(await store.delete('deploys')).toBe(false);
  });

  it('refuses an uppercase slug with PLUGIN_SLUG_INVALID', async () => {
    await expect(
      store.write('Deploys', pluginText(), { approve: false }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_SLUG_INVALID' });
    await expect(store.get('Deploys')).rejects.toMatchObject({
      errorCode: 'PLUGIN_SLUG_INVALID',
    });
  });

  it('lists plugins sorted by slug and skips files that are not plugins', async () => {
    await store.write('beta', pluginText(), { approve: true });
    await store.write('alpha', pluginText(), { approve: false });
    await writeFile(join(pluginsDir, 'notes.txt'), 'not a plugin');
    await writeFile(join(pluginsDir, 'Upper.plugin.yaml'), pluginText());

    const listed = await store.list();

    expect(listed.map((plugin) => [plugin.slug, plugin.state])).toEqual([
      ['alpha', 'changed'],
      ['beta', 'approved'],
    ]);
  });

  it('publishes a change for each successful write, approve, update and delete', async () => {
    const written = await store.write('deploys', pluginText(), {
      approve: false,
    });
    await store.approve('deploys', written.hash);
    const updated = await store.update('deploys', written.hash, (text) =>
      text.replace('Deploys', 'Deploys 2'),
    );
    await store.delete('deploys');
    expect(events).toEqual([
      { slug: 'deploys' },
      { slug: 'deploys' },
      { slug: 'deploys' },
      { slug: 'deploys' },
    ]);

    await expect(
      store.write('deploys', pluginText(), {
        baseHash: updated.hash,
        approve: false,
      }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_CHANGED' });
    expect(events).toHaveLength(4);
  });
});
