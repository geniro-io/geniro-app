import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
  session: { defaultSession: {} },
}));

import { measureWithDu, readAppStorage } from './app-storage';

const write = (path: string, bytes: number): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x'.repeat(bytes));
};

beforeEach(() => {
  mocks.userData = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-storage-')));
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

describe('measureWithDu', () => {
  it('counts a hard-linked file once across every path it is asked about', async () => {
    write(join(mocks.userData, 'a', 'big.bin'), 200_000);
    mkdirSync(join(mocks.userData, 'b'));
    linkSync(
      join(mocks.userData, 'a', 'big.bin'),
      join(mocks.userData, 'b', 'big.bin'),
    );

    const sizes = await measureWithDu(mocks.userData, ['a', 'b']);

    expect(sizes.get('a')).toBeGreaterThanOrEqual(200_000);
    expect(sizes.get('b')).toBeLessThan(100_000);
  });

  it('answers 0 for a path that does not exist instead of failing the rest', async () => {
    write(join(mocks.userData, 'here.bin'), 50_000);

    const sizes = await measureWithDu(mocks.userData, ['gone', 'here.bin']);

    expect(sizes.get('gone')).toBe(0);
    expect(sizes.get('here.bin')).toBeGreaterThanOrEqual(50_000);
  });
});

describe('readAppStorage', () => {
  it('sizes only the names it was handed, worktrees one by one with their cards', async () => {
    write(join(mocks.userData, 'Cache', 'data'), 30_000);
    write(join(mocks.userData, 'Cookies'), 10_000);
    write(join(mocks.userData, 'geniro.db'), 10_000);
    write(join(mocks.userData, 'worktrees', 't1', 'file'), 40_000);
    write(join(mocks.userData, 'worktrees', 'loose.log'), 10);
    writeFileSync(
      join(mocks.userData, 'worktrees.json'),
      JSON.stringify([
        {
          taskId: 't1',
          path: join(mocks.userData, 'worktrees', 't1'),
          branch: 'geniro/task-t1',
          folder: '/repo',
          createdAt: '',
        },
      ]),
    );

    const usage = await readAppStorage(
      mocks.userData,
      ['Cache', 'Cookies', 'worktrees', 'worktrees.json', 'missing'],
      (ids) => Promise.resolve(new Set(ids)),
    );

    expect(usage.browserCache.map((entry) => entry.name)).toEqual(['Cache']);
    expect(usage.appData.map((entry) => entry.name)).toEqual([
      'Cookies',
      'worktrees.json',
    ]);
    expect(usage.worktrees).toEqual([
      expect.objectContaining({
        name: 'loose.log',
        kind: 'file',
        taskId: null,
        cardFinished: null,
      }),
      expect.objectContaining({
        name: 't1',
        kind: 'folder',
        taskId: 't1',
        branch: 'geniro/task-t1',
        cardFinished: true,
      }),
    ]);
    expect(usage.worktrees[1]!.bytes).toBeGreaterThanOrEqual(40_000);
  });
});

describe('readAppStorage — a real worktree', () => {
  it("reads a linked worktree's checked-out branch, not the one it was made on", async () => {
    const repo = realpathSync(
      mkdtempSync(join(tmpdir(), 'geniro-storage-repo-')),
    );
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' });
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 'spec@example.com');
      git(repo, 'config', 'user.name', 'Spec');
      writeFileSync(join(repo, 'README.md'), '# repo\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'first');
      const path = join(mocks.userData, 'worktrees', 't1');
      git(repo, 'worktree', 'add', '-b', 'geniro/task-t1', path);
      git(path, 'switch', '-c', 'feat/renamed');
      writeFileSync(
        join(mocks.userData, 'worktrees.json'),
        JSON.stringify([
          {
            taskId: 't1',
            path,
            branch: 'geniro/task-t1',
            folder: repo,
            createdAt: '',
          },
        ]),
      );

      const usage = await readAppStorage(mocks.userData, ['worktrees'], () =>
        Promise.resolve(new Set<string>()),
      );

      expect(usage.worktrees).toEqual([
        expect.objectContaining({
          name: 't1',
          kind: 'worktree',
          taskId: 't1',
          branch: 'feat/renamed',
          cardFinished: false,
        }),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
