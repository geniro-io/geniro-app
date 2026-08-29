// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PullRequestsResult } from '../../shared/contracts';
import {
  pullRequestsIn,
  type PullRequestStore,
  usePullRequests,
} from './use-pull-requests';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const answerFor = (dir: string): PullRequestsResult => ({
  branch: `branch-of-${dir}`,
  originOwner: 'someone',
  pullRequests: [],
});

/**
 * A clock the tests move by hand. `usePullRequests` skips a folder the focus
 * sweep already read inside its TTL, so a real clock would make every focus
 * assertion below depend on how fast the machine ran.
 */
let now = 1_000_000_000;
/** Comfortably past REFRESH_TTL_MS (5 minutes). */
const PAST_TTL_MS = 6 * 60_000;

let getPullRequests: ReturnType<typeof vi.fn> = vi.fn();
let container: HTMLDivElement;
let root: Root;
/** The latest store the probe rendered, for the cases that call `refresh`. */
let store: PullRequestStore | null = null;

function useFakeGeniro(fn: ReturnType<typeof vi.fn>): void {
  getPullRequests = fn;
  Object.defineProperty(window, 'geniro', {
    value: { getPullRequests },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  now = 1_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store = null;
  useFakeGeniro(vi.fn(async (dir: string) => answerFor(dir)));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe({ dirs }: { dirs: string[] }): null {
  store = usePullRequests(dirs);
  return null;
}

async function mount(ui: ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

const dirsRead = (): string[] =>
  getPullRequests.mock.calls.map(([dir]) => String(dir));

/** A promise the test releases by hand, to hold a read open. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('usePullRequests', () => {
  it('reads a folder ONCE however many rows name it', async () => {
    await mount(<Probe dirs={['/proj', '/proj', '/proj']} />);

    expect(dirsRead()).toEqual(['/proj']);
    expect(store?.byDir.get('/proj')?.branch).toBe('branch-of-/proj');
  });

  it('reads folders one at a time, never all at once', async () => {
    // The gate is what makes this a real pin: it holds the first read open, so
    // a concurrent rewrite would call `/two` before `/one` resolved.
    const gate = deferred();
    useFakeGeniro(
      vi.fn(async (dir: string) => {
        if (dir === '/one') {
          await gate.promise;
        }
        return answerFor(dir);
      }),
    );

    await mount(<Probe dirs={['/one', '/two']} />);

    expect(dirsRead()).toEqual(['/one']);

    await act(async () => {
      gate.release();
    });

    expect(dirsRead()).toEqual(['/one', '/two']);
  });

  it('reads a folder that appears later without re-reading the old ones', async () => {
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    await mount(<Probe dirs={['/one', '/two']} />);

    expect(dirsRead()).toEqual(['/one', '/two']);
  });

  it('reads nothing when there are no folders', async () => {
    await mount(<Probe dirs={[]} />);

    expect(getPullRequests).not.toHaveBeenCalled();
    expect(store?.byDir.size).toBe(0);
  });

  it('re-reads only the folders still on screen when the window regains focus', async () => {
    // `/two` leaves the list before the focus, so a refresh over the
    // started-set rather than the on-screen one would read it a second time.
    await mount(<Probe dirs={['/one', '/two']} />);
    expect(dirsRead()).toEqual(['/one', '/two']);

    await mount(<Probe dirs={['/one']} />);
    now += PAST_TTL_MS;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dirsRead()).toEqual(['/one', '/two', '/one']);
  });

  it('skips a folder the sweep already read inside the freshness floor', async () => {
    // Alt-tabbing between an editor and this app is its normal rhythm, and each
    // read is three gh queries and two git reads PER FOLDER — so without the
    // floor ordinary use spends a burst of authenticated GitHub traffic every
    // few seconds re-reading folders whose pull requests cannot have moved.
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    now += 60_000;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dirsRead()).toEqual(['/one']);

    now += PAST_TTL_MS;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dirsRead()).toEqual(['/one', '/one']);
  });

  it('does NOT start the freshness clock on a read that failed', async () => {
    // Main folds every failure into the same empty shape, so stamping one would
    // pin "no pull requests" for the whole floor with no user-reachable retry —
    // a network blip costing five minutes of silence where, before the floor
    // existed, the next focus recovered.
    useFakeGeniro(
      vi.fn(async (): Promise<PullRequestsResult> => ({
        branch: null,
        originOwner: null,
        pullRequests: [],
      })),
    );
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    now += 1_000;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dirsRead()).toEqual(['/one', '/one']);
  });

  it('re-reads on demand even inside the freshness floor', async () => {
    // `refresh` is asked for BECAUSE something changed — a branch switch — so
    // the floor, which exists to skip reads that cannot have new answers, must
    // not swallow it.
    await mount(<Probe dirs={['/one']} />);

    now += 1_000;
    await act(async () => {
      store?.refresh('/one');
    });

    expect(dirsRead()).toEqual(['/one', '/one']);
  });

  it('does not stack a second refresh on top of one still running', async () => {
    // Alt-tabbing back a few times while reads are slow would otherwise run N
    // overlapping loops — the exact fan-out the sequential design prevents.
    const gate = deferred();
    let hold = false;
    useFakeGeniro(
      vi.fn(async (dir: string) => {
        if (hold) {
          await gate.promise;
        }
        return answerFor(dir);
      }),
    );
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    hold = true;
    now += PAST_TTL_MS;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });

    // One re-read in flight; the two later focus events were dropped, not queued.
    expect(dirsRead()).toEqual(['/one', '/one']);

    await act(async () => {
      gate.release();
    });

    expect(dirsRead()).toEqual(['/one', '/one']);

    // And the guard RELEASES. Without this the flag stays raised for the life of
    // the window and focus refresh silently never fires again — a failure that
    // is permanent and completely quiet, which the entry assertion above cannot
    // see.
    hold = false;
    now += PAST_TTL_MS;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dirsRead()).toEqual(['/one', '/one', '/one']);
  });

  it('keeps reading the other folders when one of them fails', async () => {
    useFakeGeniro(
      vi.fn(async (dir: string) => {
        if (dir === '/broken') {
          throw new Error('main refused the path');
        }
        return answerFor(dir);
      }),
    );

    await mount(<Probe dirs={['/broken', '/fine']} />);

    expect(dirsRead()).toEqual(['/broken', '/fine']);
    expect(store?.byDir.get('/fine')?.branch).toBe('branch-of-/fine');
  });

  it('retries a folder whose read failed, rather than marking it done', async () => {
    // The catch UN-marks the folder. Without that it stays marked started for
    // the life of the window and is never read again, so one transient failure
    // costs that thread its pull-request line permanently.
    let failing = true;
    useFakeGeniro(
      vi.fn(async (dir: string) => {
        if (failing) {
          throw new Error('main refused the path');
        }
        return answerFor(dir);
      }),
    );
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    failing = false;
    await mount(<Probe dirs={['/one', '/two']} />);

    expect(dirsRead()).toEqual(['/one', '/one', '/two']);
    expect(store?.byDir.get('/one')?.branch).toBe('branch-of-/one');
  });

  it('drops a read that a newer one for the same folder superseded', async () => {
    // Last to RESOLVE is not last to be asked for. A focus sweep's read can
    // still be in flight when a branch switch fires `refresh` for that folder;
    // without the generation guard the older reply lands second and reinstates
    // the pre-switch branch, which is what `refresh` exists to prevent.
    const slow = deferred();
    let call = 0;
    useFakeGeniro(
      vi.fn(async (): Promise<PullRequestsResult> => {
        call += 1;
        if (call === 1) {
          await slow.promise;
          return {
            branch: 'before-the-switch',
            originOwner: null,
            pullRequests: [],
          };
        }
        return {
          branch: 'after-the-switch',
          originOwner: null,
          pullRequests: [],
        };
      }),
    );
    await mount(<Probe dirs={['/one']} />);

    // The first read is still in flight when the second is asked for.
    await act(async () => {
      store?.refresh('/one');
    });
    expect(store?.byDir.get('/one')?.branch).toBe('after-the-switch');

    await act(async () => {
      slow.release();
    });

    expect(store?.byDir.get('/one')?.branch).toBe('after-the-switch');
  });

  it('re-reads one folder on demand, which is what a branch switch needs', async () => {
    // An in-app branch switch never loses window focus, so the focus refresh
    // cannot cover it and the composer band would keep naming the old branch's
    // pull request.
    await mount(<Probe dirs={['/one']} />);
    expect(dirsRead()).toEqual(['/one']);

    await act(async () => {
      store?.refresh('/one');
    });

    expect(dirsRead()).toEqual(['/one', '/one']);
  });
});

describe('pullRequestsIn', () => {
  it('answers the unread shape for a folder not read yet, and for none', () => {
    const empty = new Map<string, PullRequestsResult>();

    // The same shape a folder gh cannot speak for returns, so no surface has to
    // tell "not yet" from "nothing to show".
    expect(pullRequestsIn(empty, '/unknown')).toEqual({
      branch: null,
      originOwner: null,
      pullRequests: [],
    });
    expect(pullRequestsIn(empty, null).pullRequests).toEqual([]);
  });

  it('answers the folder’s own entry once it has one', () => {
    const map = new Map([['/proj', answerFor('/proj')]]);

    expect(pullRequestsIn(map, '/proj').branch).toBe('branch-of-/proj');
  });
});
