import { describe, expect, it } from 'vitest';

import { readSavePluginArgs } from './save-plugin.reader';

const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/title' } },
];

const MINIMAL = { name: 'Prod deploys', command: 'echo {}', view: VIEW };

describe('readSavePluginArgs', () => {
  it('reads a minimal call', () => {
    expect(readSavePluginArgs(MINIMAL)).toEqual({ ok: true, query: MINIMAL });
  });

  it('refuses an argument the schema does not name', () => {
    const read = readSavePluginArgs({ ...MINIMAL, refresh: 5 });

    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.error).toContain('refresh');
  });

  it('reads a null optional argument as absent', () => {
    const read = readSavePluginArgs({
      ...MINIMAL,
      slug: null,
      folders: null,
      buttons: null,
      sample: null,
    });

    expect(read).toEqual({ ok: true, query: MINIMAL });
    expect(read.ok && 'folders' in read.query).toBe(false);
  });
});
