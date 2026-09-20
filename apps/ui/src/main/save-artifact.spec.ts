import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));

const { saveArtifact } = await import('./save-artifact');

const DOC = {
  suggestedName: 'workspaces-plan',
  html: '<!doctype html><html><body><p>the page</p></body></html>',
};

let dir = '';

beforeEach(() => {
  mocks.showSaveDialog.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'geniro-artifact-'));
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

describe('saveArtifact', () => {
  it('offers HTML, and suggests a name carrying that extension', async () => {
    // The suggested name has no extension of its own — main appends the
    // filter's, so the name the panel opens with and the filter it opens on
    // cannot disagree.
    picks('workspaces-plan.html');
    await saveArtifact(DOC);

    const options = mocks.showSaveDialog.mock.calls[0]![0] as {
      defaultPath: string;
      filters: { extensions: string[] }[];
    };
    expect(options.filters).toHaveLength(1);
    expect(options.filters[0]!.extensions).toEqual(['html']);
    expect(options.defaultPath).toMatch(/workspaces-plan\.html$/);
  });

  it('writes the document to the chosen path, byte for byte', async () => {
    const path = picks('workspaces-plan.html');

    const result = await saveArtifact(DOC);

    expect(result).toEqual({ saved: true, path });
    expect(readFileSync(path, 'utf8')).toBe(DOC.html);
  });

  it('writes ONE file — an artifact has nothing beside it', async () => {
    // The page's own CSP allows no network and no external subresources, so it
    // is self-contained by construction. Nothing here gathers assets, and this
    // is what would notice if a caller ever started expecting it to.
    picks('workspaces-plan.html');

    await saveArtifact(DOC);

    expect(readdirSync(dir)).toEqual(['workspaces-plan.html']);
  });

  it('honours the name the user typed, whatever its extension', async () => {
    // With one format there is no second document to choose between, so — the
    // one place this deliberately differs from the chat export — the path is
    // not re-read to decide what to write.
    const path = picks('plan-for-review.txt');

    const result = await saveArtifact(DOC);

    expect(result.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(DOC.html);
  });

  it('writes NOTHING when the dialog is cancelled', async () => {
    // The commonest outcome of opening a save panel, and an outcome rather
    // than a failure: the caller says nothing about it.
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });

    const result = await saveArtifact(DOC);

    expect(result).toEqual({ saved: false, path: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when the panel answers no path at all', async () => {
    // Not the same reply as a cancel, and a guard worth entering: a truthiness
    // check on `canceled` alone would fall through to `writeFile(undefined)`.
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' });

    const result = await saveArtifact(DOC);

    expect(result).toEqual({ saved: false, path: null });
    expect(existsSync(join(dir, 'workspaces-plan.html'))).toBe(false);
  });
});
