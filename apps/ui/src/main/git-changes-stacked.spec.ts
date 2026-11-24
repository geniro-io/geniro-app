import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangesPullRequest } from '../shared/contracts';
import {
  addBareOrigin,
  commitFileIn,
  initGitRepo,
  makeRepoDir,
  removeRepoDir,
  runGit,
} from './__tests__/git-changes-repo';
import { readChangesSince } from './git-changes';

vi.setConfig({ testTimeout: 30_000 });

let dir = '';

const run = (args: string[]): string => runGit(dir, args);
const initRepo = (): string => initGitRepo(dir);
const addOrigin = (): string => addBareOrigin(dir);
const commitFile = (name: string, text: string, message: string): string =>
  commitFileIn(dir, name, text, message);

beforeEach(() => {
  dir = makeRepoDir();
});

afterEach(() => {
  removeRepoDir(dir);
});

describe('readChangesSince', () => {
  describe('a branch stacked on another', () => {
    /** `feature/top` on `feature/stack` on `main`, with only `feature/stack` pushed. */
    function stacked(): {
      started: string;
      stack: string;
      top: string;
      remote: string;
      pullRequest: ChangesPullRequest;
    } {
      const started = initRepo();
      const remote = addOrigin();
      run(['push', '-q', 'origin', 'main']);
      run(['switch', '-q', '-c', 'feature/stack']);
      const stack = commitFile('stack.txt', 'the branch beneath\n', 'stack');
      run(['push', '-q', 'origin', 'feature/stack']);
      run(['switch', '-q', '-c', 'feature/top']);
      const top = commitFile('mine.txt', 'this chat\n', 'mine');
      return {
        started,
        stack,
        top,
        remote,
        pullRequest: {
          repository: remote.split('/').slice(-2).join('/'),
          headRefName: 'feature/top',
          headRefOid: top,
          baseRefName: 'feature/stack',
        },
      };
    }

    it('lists the whole stack with no pull request to go by', async () => {
      const { started, remote } = stacked();
      try {
        const result = await readChangesSince(dir, started, true);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('measures from the base of the pull request its branch heads', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        const result = await readChangesSince(dir, started, true, [
          pullRequest,
        ]);

        expect(result.upstreamBase).toEqual({
          sha: run(['rev-parse', 'origin/feature/stack']),
          ref: 'origin/feature/stack',
        });
        expect(result.baseSha).toBe(run(['rev-parse', 'origin/feature/stack']));
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('goes by the branch name once the branch is past the pull request’s head', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        commitFile('unpushed.txt', 'not on GitHub yet\n', 'unpushed');

        const result = await readChangesSince(dir, started, true, [
          pullRequest,
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'unpushed.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('goes by the head commit on a branch of another name', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', '-c', 'pr-review']);

        const result = await readChangesSince(dir, started, true, [
          pullRequest,
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('measures a worktree that left the start from the same base', async () => {
      const { remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', 'main']);
        const start = commitFile('main.txt', 'unpushed start\n', 'start');
        run(['switch', '-q', 'feature/top']);

        const result = await readChangesSince(dir, start, true, [pullRequest]);

        expect(result.movedOffStart).toBe(false);
        expect(result.upstreamBase?.ref).toBe('origin/feature/stack');
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('takes no pull request of another repository for a same-named branch', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, repository: 'acme/other' },
        ]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('finds a detached worktree with commits of its own past the head', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', '--detach']);
        commitFile('review-fix.txt', 'on top of the head\n', 'review fix');

        const result = await readChangesSince(dir, started, true, [
          pullRequest,
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'review-fix.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('finds a detached worktree behind a head only its commit reaches', async () => {
      const { started, top, remote, pullRequest } = stacked();
      try {
        const moved = commitFile('later.txt', 'never tracked\n', 'later');
        run(['switch', '-q', '--detach', top]);

        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, headRefOid: moved },
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('finds the pull request of a detached worktree sitting at its head', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', '--detach']);

        const result = await readChangesSince(dir, started, true, [
          pullRequest,
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('finds it from a detached worktree the branch has moved on from', async () => {
      const { started, top, remote, pullRequest } = stacked();
      try {
        commitFile('later.txt', 'pushed after\n', 'later');
        run(['push', '-q', 'origin', 'feature/top']);
        run(['switch', '-q', '--detach', top]);

        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, headRefOid: 'b'.repeat(40) },
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('gives a stale detached worktree of a lower pull request that one, not the one above', async () => {
      const { started, stack, top, remote, pullRequest } = stacked();
      try {
        run(['push', '-q', 'origin', 'feature/top']);
        run(['switch', '-q', '--detach', 'HEAD~1']);
        commitFile('between.txt', 'a detached commit\n', 'between');
        const lowerHead = run(['rev-parse', 'HEAD']);
        run(['push', '-q', 'origin', 'HEAD:refs/heads/feature/lower']);
        run(['switch', '-q', '--detach', stack]);

        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, headRefOid: top },
          {
            ...pullRequest,
            headRefName: 'feature/lower',
            headRefOid: lowerHead,
            baseRefName: 'main',
          },
        ]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('passes over a pull request whose base was never fetched for the next one that fits', async () => {
      const { started, top, remote, pullRequest } = stacked();
      try {
        commitFile('later.txt', 'pushed after\n', 'later');
        run(['push', '-q', 'origin', 'feature/top']);
        run(['switch', '-q', '--detach', top]);
        const stale = { ...pullRequest, headRefOid: 'b'.repeat(40) };

        const result = await readChangesSince(dir, started, true, [
          { ...stale, baseRefName: 'feature/never-fetched' },
          stale,
        ]);

        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('reads a detached worktree on no pull request’s branch as before', async () => {
      const { started, top, remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', '--detach', top]);

        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, headRefOid: 'b'.repeat(40) },
          { ...pullRequest, headRefOid: undefined },
        ]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('lets the default branch answer when the pull request’s base lies before the start', async () => {
      const { remote, pullRequest } = stacked();
      try {
        run(['switch', '-q', 'main']);
        const start = commitFile('pulled-1.txt', 'upstream\n', 'pulled 1');
        commitFile('pulled-2.txt', 'upstream\n', 'pulled 2');
        run(['push', '-q', 'origin', 'main']);
        const shared = run(['rev-parse', 'origin/main']);
        run(['switch', '-q', '-c', 'feature/late']);
        commitFile('late.txt', 'this chat\n', 'late');

        const result = await readChangesSince(dir, start, true, [
          {
            ...pullRequest,
            headRefName: 'feature/late',
            headRefOid: undefined,
          },
        ]);

        expect(result.upstreamBase).toEqual({
          sha: shared,
          ref: 'origin/main',
        });
        expect(result.changes.map((change) => change.path)).toEqual([
          'late.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('does not lend a pull request to a named branch behind its head', async () => {
      const { started, top, remote, pullRequest } = stacked();
      try {
        const moved = commitFile('later.txt', 'pushed after\n', 'later');
        run(['push', '-q', 'origin', 'feature/top']);
        run(['switch', '-q', '-c', 'other', top]);

        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, headRefOid: moved },
        ]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('falls back to the default branch when the base was never fetched', async () => {
      const { started, remote, pullRequest } = stacked();
      try {
        const result = await readChangesSince(dir, started, true, [
          { ...pullRequest, baseRefName: 'feature/never-fetched' },
        ]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'mine.txt',
          'stack.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('keeps the start when the chat began past the pull request’s base', async () => {
      const { top, remote, pullRequest } = stacked();
      try {
        commitFile('after.txt', 'after the start\n', 'after');

        const result = await readChangesSince(dir, top, true, [pullRequest]);

        expect(result.upstreamBase).toBeNull();
        expect(result.changes.map((change) => change.path)).toEqual([
          'after.txt',
        ]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  it('says a plain folder is not a repository', async () => {
    const result = await readChangesSince(dir, 'c'.repeat(40));

    expect(result.unavailableReason).toBe('Not a git repository.');
    expect(result.baseSha).toBeNull();
  });
});
