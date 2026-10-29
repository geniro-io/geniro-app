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

const { saveMemoryExport } = await import('./save-memory-export');

const MARKDOWN = '# Memory\n\n- prefers pnpm\n';

let dir = '';

beforeEach(() => {
  mocks.showSaveDialog.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'geniro-memory-export-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function picks(name: string): string {
  const filePath = join(dir, name);
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });
  return filePath;
}

describe('saveMemoryExport', () => {
  it('suggests geniro-memory-<today>.md and offers only Markdown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0));
    picks('geniro-memory-2026-01-05.md');

    await saveMemoryExport(MARKDOWN);

    const options = mocks.showSaveDialog.mock.calls[0]![0] as {
      defaultPath: string;
      filters: { extensions: string[] }[];
    };
    expect(options.defaultPath).toBe('geniro-memory-2026-01-05.md');
    expect(options.filters).toHaveLength(1);
    expect(options.filters[0]!.extensions).toEqual(['md']);
  });

  it('writes the text to the chosen path, byte for byte', async () => {
    const path = picks('notes.md');

    const result = await saveMemoryExport(MARKDOWN);

    expect(result).toEqual({ saved: true, path });
    expect(readFileSync(path, 'utf8')).toBe(MARKDOWN);
  });

  it('writes nothing and reports cancelled when the dialog is cancelled', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });

    const result = await saveMemoryExport(MARKDOWN);

    expect(result).toEqual({ saved: false, path: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when the panel answers no path at all', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' });

    const result = await saveMemoryExport(MARKDOWN);

    expect(result).toEqual({ saved: false, path: null });
    expect(existsSync(join(dir, 'geniro-memory-2026-01-05.md'))).toBe(false);
  });
});
