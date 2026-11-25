import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  pluginFileText,
  readPluginText,
  resolvePluginFolder,
  withPluginSettings,
} from './plugin-file';

const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/title' } },
];

const BASE = { name: 'Deploys', command: 'echo {}', view: VIEW };

function refusalOf(value: Record<string, unknown>): string {
  const read = readPluginText(stringify(value));
  if (read.ok) {
    throw new Error(`read as valid: ${JSON.stringify(read.plugin)}`);
  }
  return read.error;
}

describe('readPluginText', () => {
  it('reads a valid file with the defaults applied', () => {
    expect(
      readPluginText(
        stringify({
          ...BASE,
          buttons: [{ id: 'retry', command: 'echo retry' }],
        }),
      ),
    ).toMatchObject({
      ok: true,
      plugin: {
        name: 'Deploys',
        enabled: true,
        folders: [],
        resolvedFolders: [],
        refresh_minutes: 5,
        timeout_seconds: 30,
        buttons: [
          {
            id: 'retry',
            command: 'echo retry',
            confirm: false,
            timeout_minutes: 10,
          },
        ],
      },
    });
  });

  it('refuses a file with no name, at /name', () => {
    expect(refusalOf({ command: BASE.command, view: BASE.view })).toMatch(
      /^\/name: /,
    );
  });

  it('refuses a command that spans two lines, at /command', () => {
    expect(refusalOf({ ...BASE, command: 'echo a\necho b' })).toMatch(
      /^\/command: /,
    );
  });

  it('refuses an unknown top-level key by name', () => {
    expect(refusalOf({ ...BASE, colour: 'red' })).toMatch(/colour/);
  });

  it('refuses an env name outside PLUGIN_*, at its button', () => {
    expect(
      refusalOf({
        ...BASE,
        buttons: [{ id: 'retry', command: 'echo a', env: { PATH: '/title' } }],
      }),
    ).toMatch(/^\/buttons\/0\/env\/PATH: /);
  });

  it('refuses an env value that is not a JSON pointer, at its name', () => {
    expect(
      refusalOf({
        ...BASE,
        buttons: [
          {
            id: 'retry',
            command: 'echo a',
            env: { PLUGIN_TITLE: 'title' },
          },
        ],
      }),
    ).toMatch(/^\/buttons\/0\/env\/PLUGIN_TITLE: /);
  });

  it('refuses a component the catalog does not have, at its view index', () => {
    expect(
      refusalOf({
        ...BASE,
        view: [VIEW[0], { id: 'title', component: 'Carousel' }],
      }),
    ).toMatch(/^\/view\/1\/component: /);
  });

  it('refuses an input component, at its view index', () => {
    expect(
      refusalOf({
        ...BASE,
        view: [
          { id: 'root', component: 'Column', children: ['code'] },
          {
            id: 'code',
            component: 'TextField',
            label: 'Code',
            value: { '@path': '/code' },
          },
        ],
      }),
    ).toBe(
      '/view/1/component: a plugin view shows data only; TextField is not allowed',
    );
  });

  it('refuses an overlay component, at its view index', () => {
    expect(
      refusalOf({
        ...BASE,
        view: [
          { id: 'root', component: 'Column', children: ['modal', 'body'] },
          {
            id: 'modal',
            component: 'Modal',
            trigger: 'open',
            content: 'body',
          },
          { id: 'open', component: 'Text', text: 'Open' },
          { id: 'body', component: 'Text', text: 'Body' },
        ],
      }),
    ).toBe(
      '/view/1/component: a plugin view shows data only; Modal is not allowed',
    );
  });

  it('refuses a button event that names no declared button, at its action', () => {
    const view = [
      { id: 'root', component: 'Column', children: ['go', 'go_label'] },
      {
        id: 'go',
        component: 'Button',
        child: 'go_label',
        action: { event: { name: 'missing', context: {} } },
      },
      { id: 'go_label', component: 'Text', text: 'Go' },
    ];
    expect(refusalOf({ ...BASE, view })).toMatch(
      /^\/view\/1\/action\/event\/name: names no button in `buttons` \(none declared\)$/,
    );
    expect(
      readPluginText(
        stringify({
          ...BASE,
          view,
          buttons: [{ id: 'missing', command: 'echo missing' }],
        }),
      ).ok,
    ).toBe(true);
  });

  it('refuses a view with no component whose id is "root"', () => {
    expect(
      refusalOf({
        ...BASE,
        view: [{ id: 'title', component: 'Text', text: 'Hello' }],
      }),
    ).toBe('/view: one component must have the id "root"');
  });

  it('refuses a relative folder, at its index', () => {
    expect(refusalOf({ ...BASE, folders: ['work/app'] })).toBe(
      '/folders/0: must be an absolute path or start with ~/',
    );
  });

  it('refuses two buttons with one id, at the second', () => {
    expect(
      refusalOf({
        ...BASE,
        buttons: [
          { id: 'retry', command: 'echo a' },
          { id: 'retry', command: 'echo b' },
        ],
      }),
    ).toBe('/buttons/1/id: "retry" is used by another button');
  });

  it('passes a button that opens a link whose url is bound to the data', () => {
    expect(
      readPluginText(
        stringify({
          ...BASE,
          view: [
            { id: 'root', component: 'Column', children: ['open', 'label'] },
            {
              id: 'open',
              component: 'Button',
              child: 'label',
              action: {
                functionCall: {
                  '@call': 'openUrl',
                  args: { url: { '@path': '/data/url' } },
                },
              },
            },
            { id: 'label', component: 'Text', text: 'Open' },
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('resolvePluginFolder', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'geniro-plugin-folder-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('expands ~ and ~/ to the home directory', async () => {
    expect(resolvePluginFolder('~')).toBe(await realpath(homedir()));
    expect(resolvePluginFolder('~/geniro-plugin-spec')).toBe(
      join(homedir(), 'geniro-plugin-spec'),
    );
  });

  it('answers null for a relative path', () => {
    expect(resolvePluginFolder('work/app')).toBeNull();
  });

  it('resolves a symlink to the folder it points at', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    const link = join(root, 'link');
    await symlink(real, link);
    expect(resolvePluginFolder(link)).toBe(await realpath(real));
  });
});

describe('pluginFileText', () => {
  it('writes the keys in the file order when there is no existing text', () => {
    const text = pluginFileText({
      buttons: [],
      view: VIEW,
      command: 'echo {}',
      name: 'Deploys',
    });
    expect(text.split('\n')[0]).toBe('name: Deploys');
    expect(readPluginText(text)).toMatchObject({
      ok: true,
      plugin: { name: 'Deploys', command: 'echo {}' },
    });
  });

  it('keeps the comments of untouched keys and drops a key the input leaves out', () => {
    const existing = [
      '# owner: ops',
      'name: Deploys',
      'enabled: true',
      'folders:',
      '  - /tmp',
      'refresh_minutes: 5',
      'command: echo {} # the data source',
      'view:',
      '  - id: root',
      '    component: Column',
      '    children:',
      '      - title',
      '  - id: title',
      '    component: Text',
      '    text:',
      '      "@path": /title',
      '',
    ].join('\n');

    const text = pluginFileText(
      { name: 'Deploys', command: 'echo {}', refresh_minutes: 10, view: VIEW },
      existing,
    );

    expect(text).toContain('# owner: ops');
    expect(text).toContain('# the data source');
    expect(text).toContain('refresh_minutes: 10');
    expect(text).not.toMatch(/^enabled:/m);
    expect(text).not.toMatch(/^folders:/m);
    expect(readPluginText(text)).toMatchObject({
      ok: true,
      plugin: { refresh_minutes: 10, enabled: true, folders: [] },
    });
  });
});

describe('withPluginSettings', () => {
  it('changes enabled and folders and keeps the comments', () => {
    const text = [
      '# owner: ops',
      'name: Deploys # the name',
      'enabled: true',
      'folders: []',
      'command: echo {}',
      'view:',
      '  - id: root',
      '    component: Column',
      '    children:',
      '      - title',
      '  - id: title',
      '    component: Text',
      '    text: Hello',
      '',
    ].join('\n');

    const changed = withPluginSettings(text, {
      enabled: false,
      folders: ['/tmp/deploys'],
    });

    expect(changed).toContain('# owner: ops');
    expect(changed).toContain('# the name');
    expect(readPluginText(changed)).toMatchObject({
      ok: true,
      plugin: { enabled: false, folders: ['/tmp/deploys'] },
    });
  });
});
