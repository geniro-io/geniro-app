import { describe, expect, it } from 'vitest';

import {
  closeInterruptedRuns,
  type InterruptedRunsDeps,
} from './interrupted-runs';
import type { PreviousStop } from './previous-stop';
import type { InterruptCause } from './stop-cause';

const KILLED: PreviousStop = {
  cause: 'unknown',
  detail: 'killed by SIGKILL, memory 1.2 GB',
};

function harness(
  stop: PreviousStop = { cause: 'crash', detail: null },
  settle: () => Promise<void> = async () => undefined,
) {
  const calls: string[] = [];
  const details: {
    owner: 'chats' | 'teams';
    cause: InterruptCause;
    detail: string | null;
  }[] = [];
  const errors: string[] = [];
  let reads = 0;
  const deps: InterruptedRunsDeps = {
    readStop: () => {
      reads += 1;
      calls.push('read');
      return stop;
    },
    chats: {
      reconcileOrphanedRuns: async (cause, detail) => {
        calls.push(`chats:${cause}`);
        details.push({ owner: 'chats', cause, detail });
      },
    },
    teams: {
      reconcileOrphanedRuns: async (cause, detail) => {
        calls.push(`teams:${cause}`);
        details.push({ owner: 'teams', cause, detail });
      },
    },
    tasks: {
      settleCutOffCards: async (projectId: null) => {
        calls.push(`settle:${String(projectId)}`);
        await settle();
      },
    },
    logError: (message: string) => errors.push(message),
  };
  return { deps, calls, details, errors, reads: () => reads };
}

describe('closeInterruptedRuns', () => {
  it('hands back the stop it read, so the boot never reads the removed notes again', async () => {
    const h = harness(KILLED);
    expect(await closeInterruptedRuns(h.deps)).toEqual(KILLED);
    expect(h.reads()).toBe(1);
  });

  it('reads the note once, hands its cause to both reconciles, then settles every board', async () => {
    // A second read would find the note already gone and call every
    // team's stop `unknown`; settling first would find no run closed yet.
    const h = harness();

    await closeInterruptedRuns(h.deps);

    expect(h.reads()).toBe(1);
    expect(h.calls).toEqual([
      'read',
      'chats:crash',
      'teams:crash',
      'settle:null',
    ]);
  });

  it('gives both reconciles the detail of how the previous daemon ended', async () => {
    const h = harness(KILLED);

    await closeInterruptedRuns(h.deps);

    expect(h.details).toEqual([
      { owner: 'chats', cause: 'unknown', detail: KILLED.detail },
      { owner: 'teams', cause: 'unknown', detail: KILLED.detail },
    ]);
  });

  it.each([
    ['crash', true],
    ['quit', true],
    ['unknown', true],
    ['self-update', false],
    ['restart', false],
  ] as const)(
    'after a %s drops continuations no drain reached first: %s',
    async (cause, drops) => {
      const h = harness();
      h.deps.readStop = () => ({ cause, detail: null });
      const dropped: string[] = [];
      await closeInterruptedRuns({
        ...h.deps,
        dropRestartContinuations: async () => {
          dropped.push(h.calls.length === 0 ? 'before-reconciles' : 'late');
        },
      });
      expect(dropped).toEqual(drops ? ['before-reconciles'] : []);
    },
  );

  it('logs a failed board settle instead of failing the boot', async () => {
    const h = harness(undefined, async () => {
      throw new Error('database is locked');
    });

    await expect(closeInterruptedRuns(h.deps)).resolves.toEqual({
      cause: 'crash',
      detail: null,
    });

    expect(h.errors).toEqual([
      'boot settle of interrupted task cards failed: database is locked',
    ]);
  });
});
