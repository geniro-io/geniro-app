import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROCESS_IDENTITY_TOLERANCE_MS } from '../../../utils/process-identity';
import { ChildJournal, readChildJournal } from '../utils/child-journal';
import {
  StrandedChildReaper,
  type StrandedChildReaperOptions,
} from './stranded-child-reaper.service';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-reaper-'));
  path = join(dir, 'children.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const silent = { log: vi.fn(), warn: vi.fn() };

function reaper(options: StrandedChildReaperOptions = {}): {
  reaper: StrandedChildReaper;
  killed: [number, NodeJS.Signals][];
} {
  const killed: [number, NodeJS.Signals][] = [];
  return {
    killed,
    reaper: new StrandedChildReaper(path, {
      logger: silent,
      isAlive: () => false,
      killGroup: (pid, signal) => killed.push([pid, signal]),
      ...options,
    }),
  };
}

/** Write a journal as a previous launch would have, with a chosen owner pid. */
function writeJournal(
  children: { pid: number; startedAt: number; command: string }[],
  ownerPid = process.pid,
): void {
  writeFileSync(path, JSON.stringify({ version: 1, ownerPid, children }));
}

describe('StrandedChildReaper', () => {
  it('kills a confirmed stray group and clears the journal', () => {
    writeJournal([
      { pid: 500, startedAt: 1_000, command: '/bin/cursor-agent' },
    ]);
    const { reaper: r, killed } = reaper({
      startTimes: () => new Map([[500, 1_000]]),
    });

    expect(r.reap().map((c) => c.pid)).toEqual([500]);

    expect(killed).toEqual([[500, 'SIGKILL']]);
    expect(readChildJournal(path)).toBeNull();
  });

  it('leaves a RECYCLED pid alone — the check that stops it killing the user’s own CLI', () => {
    // Same pid, a start time far from what we recorded: by now this pid
    // belongs to something else. Reverting the identity check makes this kill.
    writeJournal([{ pid: 500, startedAt: 1_000, command: '/bin/claude' }]);
    const { reaper: r, killed } = reaper({
      startTimes: () =>
        new Map([[500, 1_000 + PROCESS_IDENTITY_TOLERANCE_MS + 1]]),
    });

    expect(r.reap()).toEqual([]);

    expect(killed).toEqual([]);
  });

  it('leaves a pid that is no longer alive alone', () => {
    writeJournal([{ pid: 501, startedAt: 1_000, command: '/bin/claude' }]);
    const { reaper: r, killed } = reaper({ startTimes: () => new Map() });

    expect(r.reap()).toEqual([]);
    expect(killed).toEqual([]);
    // Still cleared: those entries can never become actionable again.
    expect(readChildJournal(path)).toBeNull();
  });

  it('reaps only the confirmed entries of a mixed journal', () => {
    writeJournal([
      { pid: 1, startedAt: 100, command: 'a' },
      { pid: 2, startedAt: 200, command: 'b' },
      { pid: 3, startedAt: 300, command: 'c' },
    ]);
    const { reaper: r, killed } = reaper({
      // 1 confirmed, 2 recycled, 3 gone.
      startTimes: () =>
        new Map([
          [1, 100],
          [2, 999_999],
        ]),
    });

    expect(r.reap().map((c) => c.pid)).toEqual([1]);
    expect(killed).toEqual([[1, 'SIGKILL']]);
  });

  it('REFUSES to touch a journal whose owning daemon is still running', () => {
    // Those are another live daemon's in-flight turns, not strays.
    writeJournal([{ pid: 600, startedAt: 1_000, command: 'a' }], 424_242);
    const { reaper: r, killed } = reaper({
      isAlive: (pid) => pid === 424_242,
      startTimes: () => new Map([[600, 1_000]]),
    });

    expect(r.reap()).toEqual([]);

    expect(killed).toEqual([]);
    // And the journal SURVIVES — it is the live daemon's, not ours to erase.
    expect(readChildJournal(path)?.children).toHaveLength(1);
  });

  it('does nothing when no previous launch left a journal', () => {
    const { reaper: r, killed } = reaper({
      startTimes: () => {
        throw new Error('must not probe when there is nothing to probe');
      },
    });

    expect(r.reap()).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('clears an empty journal left by a clean shutdown', () => {
    writeJournal([]);
    const { reaper: r } = reaper();

    expect(r.reap()).toEqual([]);

    expect(readChildJournal(path)).toBeNull();
  });

  it('reaps what a real ChildJournal wrote — the two halves agree on the format', () => {
    // Guards the pair, not each side: a shape change in the writer that the
    // reader stopped understanding would leave every stray un-reaped, and
    // both files' own specs would still pass.
    new ChildJournal(path, undefined, () => 7_000).record(700, '/bin/claude');
    const { reaper: r, killed } = reaper({
      startTimes: () => new Map([[700, 7_000]]),
    });

    expect(r.reap().map((c) => c.command)).toEqual(['/bin/claude']);
    expect(killed).toEqual([[700, 'SIGKILL']]);
  });
});
