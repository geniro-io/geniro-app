import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));

const { saveChatExport } = await import('./save-chat-export');

const DOC = {
  suggestedName: 'thread-export',
  json: '{"a":1}',
  markdown: '# a',
};

let dir = '';

beforeEach(() => {
  mocks.showSaveDialog.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'geniro-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Answer the panel with a path, as a user who accepted or edited the name. */
function picks(name: string): string {
  const filePath = join(dir, name);
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });
  return filePath;
}

describe('saveChatExport', () => {
  it('offers markdown first, and suggests a name carrying that extension', async () => {
    // The suggested name has no extension of its own — main appends the default
    // filter's, so the name the panel opens with and the filter it opens on
    // cannot disagree.
    picks('thread-export.md');
    await saveChatExport(DOC);

    const options = mocks.showSaveDialog.mock.calls[0]![0] as {
      defaultPath: string;
      filters: { extensions: string[] }[];
    };
    expect(options.filters[0]!.extensions).toEqual(['md']);
    expect(options.filters[1]!.extensions).toEqual(['json']);
    expect(options.defaultPath).toMatch(/\.md$/);
  });

  it('writes the MARKDOWN for a .md path', async () => {
    const path = picks('thread-export.md');

    await expect(saveChatExport(DOC)).resolves.toEqual({ saved: true, path });
    expect(readFileSync(path, 'utf8')).toBe('# a');
  });

  it('writes the JSON for a .json path', async () => {
    // Decided from the PATH rather than the selected filter, because that is
    // what the user actually chose: the panel lets them type any name, and a
    // `.json` typed under the Markdown filter means JSON.
    const path = picks('thread-export.json');

    await saveChatExport(DOC);

    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
  });

  it('falls back to markdown for an extension neither filter names', async () => {
    // Markdown is what the panel opened on, so it is the honest answer for a
    // name the user typed without one.
    // A REAL extension neither filter names, which is what the title claims —
    // a name with none at all never enters the `extname(…) !== '.json'` arm
    // through the branch this case exists for.
    const path = picks('thread-export.txt');

    await saveChatExport(DOC);

    expect(readFileSync(path, 'utf8')).toBe('# a');
  });

  it('treats a CANCEL as an outcome, writing nothing', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });

    await expect(saveChatExport(DOC)).resolves.toEqual({
      saved: false,
      path: null,
    });
  });
});
