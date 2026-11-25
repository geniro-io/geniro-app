import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { tempDir } from '../../agents/__tests__/temp-dir';
import type { RunDao } from '../../agents/dao/run.dao';
import {
  PLUGIN_SAMPLE_MAX_CHARS,
  type SavePluginInput,
} from '../plugins.types';
import {
  type PluginProposalRead,
  PluginProposalService,
} from './plugin-proposal.service';
import { PluginStoreService } from './plugin-store.service';

const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/title' } },
];

const SAVE: SavePluginInput = {
  name: 'Prod deploys',
  command: 'echo \'{"ok":true}\'',
  view: VIEW,
};

function refused(read: PluginProposalRead): string {
  if (read.ok) {
    throw new Error(`accepted: ${JSON.stringify(read.proposal)}`);
  }
  return read.error;
}

describe('PluginProposalService.prepare', () => {
  let root: string;
  let pluginsDir: string;
  let chatFolder: string;
  let store: PluginStoreService;

  beforeEach(() => {
    root = tempDir('geniro-plugin-proposal-');
    pluginsDir = join(root, 'plugins');
    chatFolder = join(root, 'chat');
    mkdirSync(chatFolder);
    store = new PluginStoreService({ pluginsDir });
  });

  /** A service whose chat run has the given folder (null: no folder). */
  function proposalsIn(cwd: string | null): PluginProposalService {
    const runs = { getById: async () => ({ cwd }) } as unknown as RunDao;
    return new PluginProposalService(store, runs);
  }

  /** A plugin file already on disk, as the store writes it. */
  async function storePlugin(slug: string, text: string): Promise<void> {
    await store.write(slug, text, { approve: false });
  }

  const STORED_WITH_COMMENT = `name: Prod deploys
enabled: true
# Ops: keep these folders
folders:
  - /srv/deploys
command: echo '{"ok":true}'
refresh_minutes: 5
timeout_seconds: 30
view:
  - id: root
    component: Column
    children:
      - title
  - id: title
    component: Text
    text:
      '@path': /title
`;

  it('gives a new plugin with no folders the chat’s own folder', async () => {
    const read = await proposalsIn(chatFolder).prepare('run-1', SAVE);

    expect(read).toMatchObject({
      ok: true,
      proposal: { folders: [realpathSync(chatFolder)] },
    });
  });

  it('keeps folders given as an empty list, with no folder in the chat', async () => {
    const read = await proposalsIn(null).prepare('run-1', {
      ...SAVE,
      folders: [],
    });

    expect(read).toMatchObject({ ok: true, proposal: { folders: [] } });
  });

  it('derives the slug from the name, and marks a new plugin as having no previous text', async () => {
    const read = await proposalsIn(chatFolder).prepare('run-1', SAVE);

    expect(read).toMatchObject({
      ok: true,
      proposal: {
        slug: 'prod-deploys',
        previousText: null,
        baseHash: null,
      },
    });
  });

  it('takes the next free slug when the one the name derives is taken', async () => {
    await storePlugin('prod-deploys', STORED_WITH_COMMENT);

    const read = await proposalsIn(chatFolder).prepare('run-1', SAVE);

    expect(read).toMatchObject({
      ok: true,
      proposal: { slug: 'prod-deploys-2', previousText: null },
    });
  });

  it('never lets a second new plugin whose name has no Latin letters replace the first', async () => {
    const proposals = proposalsIn(chatFolder);
    const first = await proposals.prepare('run-1', { ...SAVE, name: 'Деплои' });
    const second = await proposals.prepare('run-1', {
      ...SAVE,
      name: 'Сборки',
    });
    if (!first.ok || !second.ok) {
      throw new Error('a proposal was refused');
    }
    expect([first.proposal.slug, second.proposal.slug]).toEqual([
      'plugin',
      'plugin',
    ]);
    expect(second.proposal.baseHash).toBeNull();

    await store.write(first.proposal.slug, first.proposal.text, {
      baseHash: first.proposal.baseHash,
      approve: true,
    });

    await expect(
      store.write(second.proposal.slug, second.proposal.text, {
        baseHash: second.proposal.baseHash,
        approve: true,
      }),
    ).rejects.toMatchObject({ errorCode: 'PLUGIN_CHANGED' });
    expect((await store.get('plugin'))?.plugin?.name).toBe('Деплои');
    const third = await proposals.prepare('run-1', { ...SAVE, name: 'Сборки' });
    expect(third).toMatchObject({ ok: true, proposal: { slug: 'plugin-2' } });
  });

  it('reads an existing slug as an update quoting the stored hash and text', async () => {
    await storePlugin('prod-deploys', STORED_WITH_COMMENT);
    const stored = await store.getOrThrow('prod-deploys');

    const read = await proposalsIn(chatFolder).prepare('run-1', {
      ...SAVE,
      slug: 'prod-deploys',
      command: 'echo \'{"ok":false}\'',
    });

    expect(read).toMatchObject({
      ok: true,
      proposal: {
        slug: 'prod-deploys',
        baseHash: stored.hash,
        previousText: STORED_WITH_COMMENT,
        command: 'echo \'{"ok":false}\'',
      },
    });
  });

  it('keeps the folders of an update that leaves them out', async () => {
    await storePlugin('prod-deploys', STORED_WITH_COMMENT);

    const read = await proposalsIn(chatFolder).prepare('run-1', {
      ...SAVE,
      slug: 'prod-deploys',
    });

    expect(read).toMatchObject({
      ok: true,
      proposal: { folders: ['/srv/deploys'] },
    });
  });

  it('keeps the buttons and timings of an update that leaves them out', async () => {
    await storePlugin(
      'prod-deploys',
      STORED_WITH_COMMENT.replace('refresh_minutes: 5', 'refresh_minutes: 15') +
        'buttons:\n  - id: redeploy\n    command: echo redeploy\n    confirm: true\n',
    );

    const read = await proposalsIn(chatFolder).prepare('run-1', {
      ...SAVE,
      slug: 'prod-deploys',
    });

    expect(read).toMatchObject({
      ok: true,
      proposal: {
        refreshMinutes: 15,
        buttons: [{ id: 'redeploy', command: 'echo redeploy', confirm: true }],
      },
    });
  });

  it('keeps a YAML comment of the existing file in the text it proposes', async () => {
    await storePlugin('prod-deploys', STORED_WITH_COMMENT);

    const read = await proposalsIn(chatFolder).prepare('run-1', {
      ...SAVE,
      slug: 'prod-deploys',
      command: 'echo \'{"ok":false}\'',
    });

    expect(read.ok && read.proposal.text).toContain(
      '# Ops: keep these folders',
    );
  });

  it('keeps a disabled plugin disabled when it is updated', async () => {
    await storePlugin(
      'prod-deploys',
      stringify({
        name: 'Prod deploys',
        enabled: false,
        folders: ['/srv/deploys'],
        command: 'echo {}',
        view: VIEW,
      }),
    );

    const read = await proposalsIn(chatFolder).prepare('run-1', {
      ...SAVE,
      slug: 'prod-deploys',
    });

    expect(read.ok && read.proposal.text).toContain('enabled: false');
  });

  it('refuses a view with no component whose id is "root", with its pointer', async () => {
    const error = refused(
      await proposalsIn(chatFolder).prepare('run-1', {
        ...SAVE,
        view: [
          { id: 'top', component: 'Column', children: ['title'] },
          { id: 'title', component: 'Text', text: { '@path': '/title' } },
        ],
      }),
    );

    expect(error).toBe('/view: one component must have the id "root"');
  });

  it('refuses a command that runs over one line, with its pointer', async () => {
    const error = refused(
      await proposalsIn(chatFolder).prepare('run-1', {
        ...SAVE,
        command: 'echo one\necho two',
      }),
    );

    expect(error).toMatch(/^\/command: /);
  });

  it('refuses an environment name outside PLUGIN_*, with its pointer', async () => {
    const error = refused(
      await proposalsIn(chatFolder).prepare('run-1', {
        ...SAVE,
        buttons: [
          {
            id: 'deploy',
            command: 'echo deploy',
            env: { PATH: '/id' },
          },
        ],
      }),
    );

    expect(error).toMatch(/^\/buttons\/0\/env\//);
  });

  it('refuses a sample over 256 KB, with its pointer', async () => {
    const error = refused(
      await proposalsIn(chatFolder).prepare('run-1', {
        ...SAVE,
        sample: 'x'.repeat(PLUGIN_SAMPLE_MAX_CHARS),
      }),
    );

    expect(error).toMatch(/^\/sample: at most 256 KB/);
  });

  it('refuses a new plugin in a chat with no folder when it names none', async () => {
    const error = refused(await proposalsIn(null).prepare('run-1', SAVE));

    expect(error).toMatch(/^\/folders: this chat has no folder/);
  });

  it('refuses a slug that is not lowercase, with its pointer', async () => {
    const error = refused(
      await proposalsIn(chatFolder).prepare('run-1', {
        ...SAVE,
        slug: 'Prod',
      }),
    );

    expect(error).toMatch(/^\/slug: /);
  });
});
