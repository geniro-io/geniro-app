import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_LINES_MAX,
  FILE_LINES_MAX_BYTES,
  type ReadFileLinesRequest,
} from '../shared/contracts';
import {
  commitFileIn,
  initGitRepo,
  makeRepoDir,
  removeRepoDir,
  runGit,
} from './__tests__/git-changes-repo';
import { readFileLines } from './read-file-lines';

vi.setConfig({ testTimeout: 30_000 });

let dir = '';

beforeEach(() => {
  dir = makeRepoDir();
});

afterEach(() => {
  removeRepoDir(dir);
});

function numbered(count: number): string {
  return (
    Array.from({ length: count }, (_, at) => `line ${at + 1}`).join('\n') + '\n'
  );
}

function request(
  overrides: Partial<ReadFileLinesRequest> = {},
): ReadFileLinesRequest {
  return {
    dir,
    path: 'notes.txt',
    at: 'worktree',
    from: 1,
    to: 5,
    ...overrides,
  };
}

function expectRefused(result: unknown): void {
  expect(result).toEqual({
    lines: [],
    total: 0,
    unavailableReason: expect.any(String),
  });
}

describe('readFileLines', () => {
  describe('the working copy', () => {
    it('answers the lines asked for, with the line count of the whole file', async () => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(10));

      expect(await readFileLines(request({ from: 3, to: 5 }))).toEqual({
        lines: ['line 3', 'line 4', 'line 5'],
        total: 10,
        unavailableReason: null,
      });
    });

    it('clamps a range that runs past the end of the file', async () => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(10));

      expect(await readFileLines(request({ from: 9, to: 50 }))).toEqual({
        lines: ['line 9', 'line 10'],
        total: 10,
        unavailableReason: null,
      });
    });

    it('answers no lines and a total of zero for an empty file', async () => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), '');

      expect(await readFileLines(request())).toEqual({
        lines: [],
        total: 0,
        unavailableReason: null,
      });
    });

    it('takes a range of exactly the most lines one call returns', async () => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(FILE_LINES_MAX + 5));

      const result = await readFileLines(
        request({ from: 1, to: FILE_LINES_MAX }),
      );

      expect(result.lines).toHaveLength(FILE_LINES_MAX);
      expect(result.total).toBe(FILE_LINES_MAX + 5);
    });

    it('resolves the path from the repository root when the folder is a subfolder of it', async () => {
      initGitRepo(dir);
      mkdirSync(join(dir, 'apps/ui'), { recursive: true });
      writeFileSync(join(dir, 'apps/ui/a.ts'), 'const a = 1;\n');

      expect(
        await readFileLines(
          request({
            dir: join(dir, 'apps/ui'),
            path: 'apps/ui/a.ts',
            from: 1,
            to: 1,
          }),
        ),
      ).toEqual({ lines: ['const a = 1;'], total: 1, unavailableReason: null });
    });

    it('refuses a file the working copy has deleted', async () => {
      initGitRepo(dir);
      commitFileIn(dir, 'notes.txt', numbered(2), 'notes');
      runGit(dir, ['rm', '-q', 'notes.txt']);

      expectRefused(await readFileLines(request()));
    });
  });

  describe('a commit', () => {
    it('reads the file as it stood at that commit, not as it is now', async () => {
      initGitRepo(dir);
      commitFileIn(dir, 'notes.txt', numbered(3), 'notes');
      const at = runGit(dir, ['rev-parse', 'HEAD']);
      writeFileSync(join(dir, 'notes.txt'), 'edited since\n');

      expect(
        await readFileLines(request({ at: { sha: at }, from: 1, to: 3 })),
      ).toEqual({
        lines: ['line 1', 'line 2', 'line 3'],
        total: 3,
        unavailableReason: null,
      });
    });

    it('reads a file the working copy has since deleted', async () => {
      initGitRepo(dir);
      commitFileIn(dir, 'notes.txt', numbered(2), 'notes');
      const at = runGit(dir, ['rev-parse', 'HEAD']);
      runGit(dir, ['rm', '-q', 'notes.txt']);

      expect(await readFileLines(request({ at: { sha: at } }))).toEqual({
        lines: ['line 1', 'line 2'],
        total: 2,
        unavailableReason: null,
      });
    });
  });

  describe('refusals', () => {
    it('refuses a folder that is not a git repository', async () => {
      writeFileSync(join(dir, 'notes.txt'), numbered(2));

      expect(await readFileLines(request())).toEqual({
        lines: [],
        total: 0,
        unavailableReason: 'Not a git repository.',
      });
    });

    it.each([
      ['a path that climbs out of the repository', '../notes.txt'],
      ['a path with a .. segment inside it', 'sub/../notes.txt'],
      ['an absolute path', join(tmpdir(), 'notes.txt')],
      ['a path with a NUL byte', 'notes\0.txt'],
      ['an empty path', ''],
    ])('refuses %s', async (_, path) => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(2));

      expectRefused(await readFileLines(request({ path })));
    });

    it('refuses a file inside the .git directory', async () => {
      initGitRepo(dir);

      expectRefused(await readFileLines(request({ path: '.git/config' })));
    });

    it('refuses a symlink whose target lies outside the repository', async () => {
      initGitRepo(dir);
      const outside = mkdtempSync(join(tmpdir(), 'geniro-outside-'));
      try {
        writeFileSync(join(outside, 'secret.txt'), numbered(2));
        symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

        expectRefused(await readFileLines(request({ path: 'link.txt' })));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses a path that is a folder', async () => {
      initGitRepo(dir);
      mkdirSync(join(dir, 'sub'));

      expectRefused(await readFileLines(request({ path: 'sub' })));
    });

    it('refuses a file that does not exist', async () => {
      initGitRepo(dir);

      expectRefused(await readFileLines(request({ path: 'missing.txt' })));
    });

    it('refuses a file larger than the byte cap', async () => {
      initGitRepo(dir);
      writeFileSync(
        join(dir, 'notes.txt'),
        Buffer.alloc(FILE_LINES_MAX_BYTES + 1, 0x61),
      );

      expectRefused(await readFileLines(request()));
    });

    it('refuses a binary file', async () => {
      initGitRepo(dir);
      writeFileSync(
        join(dir, 'image.bin'),
        Buffer.from([0x61, 0x00, 0x62, 0x0a]),
      );

      expectRefused(await readFileLines(request({ path: 'image.bin' })));
    });

    it.each([
      ['a range that starts before line 1', { from: 0, to: 2 }],
      ['a range that ends before it starts', { from: 3, to: 2 }],
      [
        'a range longer than the most lines one call returns',
        { from: 1, to: FILE_LINES_MAX + 1 },
      ],
    ])('refuses %s', async (_, range) => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(FILE_LINES_MAX + 5));

      expectRefused(await readFileLines(request(range)));
    });

    it.each([
      ['a sha that is not 40 lowercase hex digits', 'ABCDEF'],
      ['a sha that is an option', '--output=/tmp/x'],
    ])('refuses %s', async (_, sha) => {
      initGitRepo(dir);
      writeFileSync(join(dir, 'notes.txt'), numbered(2));

      expectRefused(await readFileLines(request({ at: { sha } })));
    });

    it('refuses a commit the repository does not hold', async () => {
      initGitRepo(dir);

      expectRefused(
        await readFileLines(request({ at: { sha: 'a'.repeat(40) } })),
      );
    });

    it('refuses a folder at a commit rather than listing its entries', async () => {
      initGitRepo(dir);
      mkdirSync(join(dir, 'sub'));
      commitFileIn(dir, 'sub/a.txt', 'a\n', 'sub');
      const at = runGit(dir, ['rev-parse', 'HEAD']);

      expectRefused(
        await readFileLines(request({ path: 'sub', at: { sha: at } })),
      );
    });

    it('refuses a file that was not in the tree at that commit', async () => {
      initGitRepo(dir);
      const at = runGit(dir, ['rev-parse', 'HEAD']);
      writeFileSync(join(dir, 'notes.txt'), numbered(2));

      expectRefused(await readFileLines(request({ at: { sha: at } })));
    });
  });
});
