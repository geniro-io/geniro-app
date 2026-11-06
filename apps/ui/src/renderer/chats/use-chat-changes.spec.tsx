// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangesPullRequest,
  GitChange,
  GitChanges,
} from '../../shared/contracts';
import { type ChatChanges, useChatChanges } from './use-chat-changes';

const RUN_FOLDER = '/repo';
const AGENT_WORKTREE = '/repo/.claude/worktrees/cw-1256-container-padding';
const START_SHA = 'f3c7ca6ae198cadd2dab94b76591b67a2184d844';

const change = (path: string, added: number, removed: number): GitChange => ({
  path,
  status: 'modified',
  diff: null,
  added,
  removed,
});

const reading = (changes: GitChange[]): GitChanges => ({
  changes,
  truncated: false,
  unavailableReason: null,
  movedOffStart: false,
  upstreamBase: null,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

/** Mounts the hook and hands back its latest answer. */
async function readHook(
  ...args: Parameters<typeof useChatChanges>
): Promise<() => ChatChanges> {
  let latest: ChatChanges | null = null;
  function Probe(): null {
    latest = useChatChanges(...args);
    return null;
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  // Let every read's promise settle before the answer is inspected.
  await act(async () => {
    await Promise.resolve();
  });
  return () => {
    if (latest === null) {
      throw new Error('the hook never rendered');
    }
    return latest;
  };
}

describe('useChatChanges', () => {
  it('counts the files an agent changed in a worktree it created, though the thread’s own folder is clean', async () => {
    // A team agent that runs `git worktree add` under the repository and
    // commits there leaves the thread's folder untouched — and a nested
    // worktree is usually gitignored, so the folder's own diff cannot see it
    // either.
    const getChangesSince = vi.fn(
      async (dir: string, _sha: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? reading([
              change('apps/web/case-overview.tsx', 6, 9),
              change('apps/web/case-progress.tsx', 3, 4),
              change('apps/web/case-insights.tsx', 2, 3),
              change('apps/web/add-to-case.tsx', 2, 2),
              change('apps/web/card-padding.ts', 2, 2),
            ])
          : reading([]),
    );
    vi.stubGlobal('geniro', { getChangesSince });

    const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

    expect(current().summary).toEqual({ files: 5, added: 15, removed: 20 });
    // Read as a work folder: measured from where its history meets the start.
    expect(getChangesSince).toHaveBeenCalledWith(
      AGENT_WORKTREE,
      START_SHA,
      true,
      [],
    );
  });

  it('hands every read the thread’s pull requests, and reads again when they land', async () => {
    // GitHub answers after the first read, and the chip is what the answer
    // corrects, so an answer that only reached the next turn's read would leave
    // a stacked branch's whole stack on screen meanwhile.
    const pullRequest = {
      repository: 'acme/platform',
      headRefName: 'feature/top',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'feature/stack',
    };
    const getChangesSince = vi.fn(
      async (
        _dir: string,
        _sha: string,
        _workFolder?: boolean,
        pullRequests: readonly unknown[] = [],
      ): Promise<GitChanges> =>
        reading(
          pullRequests.length > 0
            ? [change('mine.ts', 1, 0)]
            : [change('mine.ts', 1, 0), change('stack.ts', 9, 9)],
        ),
    );
    vi.stubGlobal('geniro', { getChangesSince });
    let latest: ChatChanges | null = null;
    function Probe({ prs }: { prs: (typeof pullRequest)[] }): null {
      latest = useChatChanges(RUN_FOLDER, START_SHA, [AGENT_WORKTREE], prs);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe prs={[]} />);
    });
    expect(latest!.summary).toEqual({ files: 2, added: 10, removed: 9 });

    await act(async () => {
      root?.render(<Probe prs={[pullRequest]} />);
    });

    expect(getChangesSince).toHaveBeenCalledWith(RUN_FOLDER, START_SHA, false, [
      pullRequest,
    ]);
    expect(getChangesSince).toHaveBeenCalledWith(
      AGENT_WORKTREE,
      START_SHA,
      true,
      [pullRequest],
    );
    expect(latest!.summary).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it('does not read again for a fresh array holding the same pull requests', async () => {
    // Callers rebuild the list on every render; a re-read per render would run
    // `git diff` each time.
    const getChangesSince = vi.fn(async (): Promise<GitChanges> =>
      reading([change('mine.ts', 1, 0)]),
    );
    vi.stubGlobal('geniro', { getChangesSince });
    const list = (): ChangesPullRequest[] => [
      {
        repository: 'acme/platform',
        headRefName: 'feature/top',
        baseRefName: 'feature/stack',
      },
    ];
    function Probe({ prs }: { prs: ReturnType<typeof list> }): null {
      useChatChanges(RUN_FOLDER, START_SHA, [], prs);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe prs={list()} />);
    });
    const reads = getChangesSince.mock.calls.length;

    await act(async () => {
      root?.render(<Probe prs={list()} />);
    });

    expect(getChangesSince.mock.calls.length).toBe(reads);
  });

  it('keeps each work folder’s own base beside its changes', async () => {
    const base = { sha: 'b'.repeat(40), ref: 'origin/feature/stack' };
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? { ...reading([change('mine.ts', 1, 0)]), upstreamBase: base }
          : reading([]),
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

    expect(current().elsewhere[0]?.upstreamBase).toEqual(base);
    expect(current().upstreamBase).toBeNull();
  });

  it('adds the folder’s own changes to the worktree’s rather than replacing them', async () => {
    // The chip states what the THREAD changed, and an agent can write in both
    // places in one thread — the folder's edits must not vanish because a
    // worktree was found too.
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? reading([change('apps/web/card-padding.ts', 2, 2)])
          : reading([change('DESIGN.md', 1, 1)]),
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

    expect(current().summary).toEqual({ files: 2, added: 3, removed: 3 });
    // Kept apart, since a repository-relative path means a different file in
    // each folder.
    expect(current().changes.map((c) => c.path)).toEqual(['DESIGN.md']);
    expect(current().elsewhere).toEqual([
      {
        folder: AGENT_WORKTREE,
        changes: [change('apps/web/card-padding.ts', 2, 2)],
        upstreamBase: null,
      },
    ]);
  });

  it('counts a change once when two worktrees on one commit both hold it', async () => {
    const releaseWorktree = '/repo/.claude/worktrees/release';
    const sameCommit = [
      change('apps/web/case-page.tsx', 10, 4),
      change('apps/web/tabs.tsx', 5, 1),
    ];
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> =>
        dir === RUN_FOLDER
          ? reading([change('DESIGN.md', 1, 1)])
          : reading(sameCommit),
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [
      AGENT_WORKTREE,
      releaseWorktree,
    ]);

    expect(current().summary).toEqual({ files: 3, added: 16, removed: 6 });
    expect(current().elsewhere).toHaveLength(2);
  });

  it('counts one path changed differently in two worktrees as one file with both changes’ lines', async () => {
    const releaseWorktree = '/repo/.claude/worktrees/release';
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? reading([change('apps/web/case-page.tsx', 10, 4)])
          : dir === releaseWorktree
            ? reading([change('apps/web/case-page.tsx', 7, 2)])
            : reading([]),
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [
      AGENT_WORKTREE,
      releaseWorktree,
    ]);

    expect(current().summary).toEqual({ files: 1, added: 17, removed: 6 });
  });

  it.each([
    ['holds no changes', reading([])],
    [
      'git cannot read',
      { ...reading([]), unavailableReason: 'Not a git repository.' },
    ],
  ])(
    'lists no section for a worktree that %s',
    async (_case, worktreeReading) => {
      // An empty section would draw a heading over nothing, and would hide the
      // dialog's "nothing has changed" for a thread that changed nothing.
      vi.stubGlobal('geniro', {
        getChangesSince: async (dir: string): Promise<GitChanges> =>
          dir === AGENT_WORKTREE ? worktreeReading : reading([]),
      });

      const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

      expect(current().elsewhere).toEqual([]);
      expect(current().summary).toEqual({
        files: 0,
        added: null,
        removed: null,
      });
    },
  );

  it('says the list is short when a worktree’s own read was cut', async () => {
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? {
              ...reading([change('apps/web/card-padding.ts', 2, 2)]),
              truncated: true,
            }
          : reading([]),
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

    expect(current().truncated).toBe(true);
  });

  it('stops counting a worktree the caller no longer names, before any read lands', async () => {
    // Two threads in one folder share the hook's reset key; the next thread's
    // chip must not carry the previous thread's worktree while it reads.
    let calls = 0;
    vi.stubGlobal('geniro', {
      getChangesSince: (dir: string): Promise<GitChanges> => {
        calls += 1;
        if (calls > 2) {
          return new Promise(() => {});
        }
        return Promise.resolve(
          dir === AGENT_WORKTREE
            ? reading([change('apps/web/card-padding.ts', 2, 2)])
            : reading([change('DESIGN.md', 1, 1)]),
        );
      },
    });
    let latest: ChatChanges | null = null;
    function Probe({ folders }: { folders: string[] }): null {
      latest = useChatChanges(RUN_FOLDER, START_SHA, folders);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe folders={[AGENT_WORKTREE]} />);
    });
    expect(latest!.summary).toEqual({ files: 2, added: 3, removed: 3 });

    await act(async () => {
      root?.render(<Probe folders={[]} />);
    });

    expect(latest!.elsewhere).toEqual([]);
    expect(latest!.summary).toEqual({ files: 1, added: 1, removed: 1 });
  });

  it('drops a worktree it cannot read and keeps the folder’s own figures', async () => {
    // A worktree removed after it was listed: its read fails, and that must
    // neither hide the folder's changes nor surface as the dialog's error.
    vi.stubGlobal('geniro', {
      getChangesSince: async (dir: string): Promise<GitChanges> => {
        if (dir === AGENT_WORKTREE) {
          throw new Error('no such directory');
        }
        return reading([change('DESIGN.md', 1, 1)]);
      },
    });

    const current = await readHook(RUN_FOLDER, START_SHA, [AGENT_WORKTREE]);

    expect(current().summary).toEqual({ files: 1, added: 1, removed: 1 });
    expect(current().elsewhere).toEqual([]);
    expect(current().error).toBeNull();
  });

  it('keeps the chip’s figures while a work folder found later is read', async () => {
    // The folders arrive after the first read (they need a git listing and a
    // daemon answer); clearing on their arrival would blink the chip away.
    let releaseWorktree: (value: GitChanges) => void = () => {};
    vi.stubGlobal('geniro', {
      getChangesSince: (dir: string): Promise<GitChanges> =>
        dir === AGENT_WORKTREE
          ? new Promise((resolve) => {
              releaseWorktree = resolve;
            })
          : Promise.resolve(reading([change('DESIGN.md', 1, 1)])),
    });
    let latest: ChatChanges | null = null;
    function Probe({ folders }: { folders: string[] }): null {
      latest = useChatChanges(RUN_FOLDER, START_SHA, folders);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe folders={[]} />);
    });

    await act(async () => {
      root?.render(<Probe folders={[AGENT_WORKTREE]} />);
    });
    expect(latest!.summary).toEqual({ files: 1, added: 1, removed: 1 });

    await act(async () => {
      releaseWorktree(reading([change('apps/web/card-padding.ts', 2, 2)]));
      await Promise.resolve();
    });
    expect(latest!.summary).toEqual({ files: 2, added: 3, removed: 3 });
  });
});
