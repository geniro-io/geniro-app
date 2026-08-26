// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  filePathsFromClipboard,
  insertPastedFilePaths,
} from './paste-file-paths';

/** jsdom implements neither `DataTransfer` nor `document.execCommand`. */
const clipboard = (files: File[]): DataTransfer =>
  ({ files }) as unknown as DataTransfer;

const doc = (name: string, type = 'text/markdown'): File =>
  new File(['x'], name, { type });

const PATHS: Record<string, string> = {
  'CLAUDE.md': '/Users/me/proj/apps/daemon/CLAUDE.md',
  'notes.txt': '/Users/me/notes.txt',
  'shot.png': '/Users/me/shot.png',
};
const resolve = (file: File): string | null => PATHS[file.name] ?? null;

describe('paste-file-paths', () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommand = vi.fn(() => true);
    document.execCommand =
      execCommand as unknown as typeof document.execCommand;
  });

  it('answers a pasted file with its FULL path, never its name', () => {
    expect(insertPastedFilePaths(clipboard([doc('CLAUDE.md')]), resolve)).toBe(
      true,
    );
    expect(execCommand).toHaveBeenCalledWith(
      'insertText',
      false,
      '/Users/me/proj/apps/daemon/CLAUDE.md',
    );
  });

  it('leaves IMAGES to the attachment strip', () => {
    // A pasted screenshot travels as bytes, so a path names a file the agent
    // has no reason to open — and the composer stages it in the same handler.
    expect(
      filePathsFromClipboard(
        clipboard([doc('shot.png', 'image/png'), doc('notes.txt')]),
        resolve,
      ),
    ).toEqual(['/Users/me/notes.txt']);
  });

  it('writes several files as several paths', () => {
    insertPastedFilePaths(
      clipboard([doc('CLAUDE.md'), doc('notes.txt')]),
      resolve,
    );
    expect(execCommand).toHaveBeenCalledWith(
      'insertText',
      false,
      '/Users/me/proj/apps/daemon/CLAUDE.md /Users/me/notes.txt',
    );
  });

  it('keeps its hands off a paste that carried no file', () => {
    // The ordinary case — text — must still paste itself.
    expect(insertPastedFilePaths(clipboard([]), resolve)).toBe(false);
    expect(insertPastedFilePaths(null, resolve)).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('gives the paste back when the file has no path on disk', () => {
    // `webUtils.getPathForFile` answers '' for a file built in JS; swallowing
    // the event then would lose the paste outright, which is worse than the
    // bare name the browser would have written.
    expect(
      insertPastedFilePaths(clipboard([doc('made-up.txt')]), resolve),
    ).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('gives the paste back when the field refused the insertion', () => {
    execCommand.mockReturnValue(false);
    expect(insertPastedFilePaths(clipboard([doc('notes.txt')]), resolve)).toBe(
      false,
    );
  });
});
