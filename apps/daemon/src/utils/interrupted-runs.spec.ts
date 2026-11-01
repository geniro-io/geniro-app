import { describe, expect, it } from 'vitest';

import { closeInterruptedRuns } from './interrupted-runs';
import type { InterruptCause } from './stop-cause';

function harness(settle: () => Promise<void> = async () => undefined) {
  const calls: string[] = [];
  const errors: string[] = [];
  let reads = 0;
  const deps = {
    readCause: (): InterruptCause => {
      reads += 1;
      calls.push('read');
      return 'crash';
    },
    chats: {
      reconcileOrphanedRuns: async (cause: InterruptCause) => {
        calls.push(`chats:${cause}`);
      },
    },
    teams: {
      reconcileOrphanedRuns: async (cause: InterruptCause) => {
        calls.push(`teams:${cause}`);
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
  return { deps, calls, errors, reads: () => reads };
}

describe('closeInterruptedRuns', () => {
  it('hands back the cause it read, so the boot never reads the removed note again', async () => {
    const { deps, reads } = harness();
    expect(await closeInterruptedRuns(deps)).toBe('crash');
    expect(reads()).toBe(1);
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

  it('logs a failed board settle instead of failing the boot', async () => {
    const h = harness(async () => {
      throw new Error('database is locked');
    });

    await expect(closeInterruptedRuns(h.deps)).resolves.toBe('crash');

    expect(h.errors).toEqual([
      'boot settle of interrupted task cards failed: database is locked',
    ]);
  });
});
