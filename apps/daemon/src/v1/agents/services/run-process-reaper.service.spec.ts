import { describe, expect, it, vi } from 'vitest';

import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import { RUN_ID_ENV, type ScannedProcess } from '../utils/run-process-scan';
import {
  RunProcessReaper,
  type RunProcessReaperOptions,
} from './run-process-reaper.service';

const RUN = 'run-1111';
const SELF = 900;
const UID = 501;

function row(
  pid: number,
  ppid: number,
  args: string,
  overrides: Partial<ScannedProcess> = {},
): ScannedProcess {
  return {
    pid,
    ppid,
    uid: UID,
    startedAt: pid * 10,
    args,
    env: '',
    ...overrides,
  };
}

const tag = (runId = RUN): string => `${RUN_ID_ENV}=${runId}`;

/** Start times as the kernel would report them for the listed rows. */
const sameAsListed = (pids: number[]): Map<number, number> =>
  new Map(pids.map((pid) => [pid, pid * 10]));

function reaper(
  rows: ScannedProcess[] | null,
  options: RunProcessReaperOptions = {},
): {
  reaper: RunProcessReaper;
  signals: [number, NodeJS.Signals][];
  waits: number[];
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  scan: ReturnType<typeof vi.fn>;
} {
  const signals: [number, NodeJS.Signals][] = [];
  const waits: number[] = [];
  const logger = { log: vi.fn(), warn: vi.fn() };
  const scan = vi.fn(() => Promise.resolve(rows));
  return {
    signals,
    waits,
    logger,
    scan,
    reaper: new RunProcessReaper({
      scan,
      signal: (pid, sig) => signals.push([pid, sig]),
      startTimes: sameAsListed,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      logger,
      selfPid: SELF,
      uid: UID,
      ...options,
    }),
  };
}

describe('RunProcessReaper', () => {
  it('sends SIGTERM to the run tree, waits the grace, then SIGKILLs only confirmed survivors', async () => {
    let probes = 0;
    const {
      reaper: subject,
      signals,
      waits,
    } = reaper(
      [
        row(10, 1, 'node turbo run dev', { env: tag() }),
        row(11, 10, 'next-server (v16.3.8)', { env: null }),
        row(12, 10, 'node tsc --watch'),
      ],
      {
        startTimes: (pids) => {
          probes += 1;
          if (probes === 1) {
            return sameAsListed(pids);
          }
          // After the grace: 10 exited, 11 still runs, 12's pid now belongs
          // to a process that started later — a recycled pid.
          return new Map([
            [11, 110],
            [12, 99_999],
          ]);
        },
      },
    );

    const stopped = await subject.reap(RUN);

    expect(stopped.sort()).toEqual([10, 11, 12]);
    expect(waits).toEqual([GROUP_KILL_GRACE_MS]);
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [12, 'SIGTERM'],
      [11, 'SIGKILL'],
    ]);
  });

  it('logs every pid it signals', async () => {
    const { reaper: subject, logger } = reaper([
      row(10, 1, 'node server.js', { env: tag() }),
    ]);
    await subject.reap(RUN);
    expect(logger.log).toHaveBeenCalledWith(
      `SIGTERM pid 10 (node server.js) of run ${RUN}`,
    );
  });

  it.each(['', '  '])(
    'reads nothing and signals nothing for the run id %j',
    async (runId) => {
      const {
        reaper: subject,
        signals,
        scan,
      } = reaper([row(10, 1, 'node a.js', { env: `${RUN_ID_ENV}=` })]);
      expect(await subject.reap(runId)).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
      expect(signals).toEqual([]);
    },
  );

  it('signals nothing, and does not wait, for another run', async () => {
    const {
      reaper: subject,
      signals,
      waits,
    } = reaper([row(10, 1, 'node a.js', { env: tag('run-2222') })]);
    expect(await subject.reap(RUN)).toEqual([]);
    expect(signals).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('signals nothing when the process table cannot be read', async () => {
    const { reaper: subject, signals, logger } = reaper(null);
    expect(await subject.reap(RUN)).toEqual([]);
    expect(signals).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('signals nothing over the cap, and says how many matched', async () => {
    const rows = [
      row(10, 1, 'node root.js', { env: tag() }),
      ...Array.from({ length: 300 }, (_, i) => row(1000 + i, 10, 'node w.js')),
    ];
    const { reaper: subject, signals, logger } = reaper(rows);
    expect(await subject.reap(RUN)).toEqual([]);
    expect(signals).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('matched 301 processes'),
    );
  });

  it('never signals the daemon itself, even tagged', async () => {
    const { reaper: subject, signals } = reaper([
      row(SELF, 1, 'node daemon/main.js', { env: tag() }),
      row(10, 1, 'node server.js', { env: tag() }),
    ]);
    await subject.reap(RUN);
    expect(signals.map(([pid]) => pid)).not.toContain(SELF);
    expect(signals).toContainEqual([10, 'SIGTERM']);
  });

  it('never signals a process whose identity it cannot confirm', async () => {
    const { reaper: subject, signals } = reaper(
      [
        row(10, 1, 'node a.js', { env: tag(), startedAt: null }),
        row(11, 1, 'node b.js', { env: tag() }),
      ],
      // 11's pid was recycled between the listing and the signal: what holds
      // it now started a minute after the process that was listed.
      { startTimes: () => new Map([[11, 110 + 60_000]]) },
    );
    expect(await subject.reap(RUN)).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('steps over a process that exits between the probe and the signal', async () => {
    const { reaper: subject } = reaper(
      [
        row(10, 1, 'node a.js', { env: tag() }),
        row(11, 1, 'node b.js', { env: tag() }),
      ],
      {
        signal: (pid) => {
          if (pid === 10) {
            throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
          }
        },
      },
    );
    expect(await subject.reap(RUN)).toEqual([11]);
  });

  it('reports a failed background reap as a warning instead of rejecting', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const subject = new RunProcessReaper({
      scan: () => Promise.reject(new Error('boom')),
      logger,
      selfPid: SELF,
      uid: UID,
    });
    subject.reapInBackground(RUN);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        `could not stop the processes of run ${RUN}: boom`,
      ),
    );
  });
});
