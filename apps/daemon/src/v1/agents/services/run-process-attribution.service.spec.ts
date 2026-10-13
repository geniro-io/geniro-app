import { describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  runOwnerOf,
  type ScannedProcess,
} from '../utils/run-process-scan';
import {
  currentRunOwner,
  READOUT_SCAN_MAX_AGE_MS,
  RunProcessAttribution,
  type RunProcessAttributionOptions,
} from './run-process-attribution.service';

const OWNER = 'aaaaaaaaaaaaaaaa';
const RUN = 'run-1111';

const proc = (pid: number, args: string): ScannedProcess => ({
  pid,
  ppid: 1,
  uid: 501,
  tty: null,
  startedAt: 1_000,
  args,
  env: `${RUN_ID_ENV}=${RUN} ${RUN_OWNER_ENV}=${OWNER}`,
});

function attribution(
  rows: ScannedProcess[] | null,
  options: RunProcessAttributionOptions = {},
) {
  let now = 0;
  const scan = vi.fn(() => Promise.resolve(rows));
  const subject = new RunProcessAttribution(OWNER, {
    scan,
    selfPid: 900,
    uid: 501,
    now: () => now,
    ...options,
  });
  return {
    subject,
    scan,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RunProcessAttribution', () => {
  it('stamps with the same owner it searches by', () => {
    expect(currentRunOwner()).toBe(runOwnerOf(environment.userDataDir));
  });

  it('serves readouts one reading for a while, and a kill always a fresh one', async () => {
    const { subject, scan, advance } = attribution([proc(10, 'node a.js')]);
    await subject.attribute('readout');
    await subject.attribute('readout');
    expect(scan).toHaveBeenCalledTimes(1);
    await subject.attribute('fresh');
    expect(scan).toHaveBeenCalledTimes(2);
    advance(READOUT_SCAN_MAX_AGE_MS);
    await subject.attribute('readout');
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('does not serve a failed reading to the next readout', async () => {
    const scan = vi
      .fn<() => Promise<ScannedProcess[] | null>>()
      .mockRejectedValueOnce(new Error('ps died'))
      .mockResolvedValue([proc(10, 'node a.js')]);
    const { subject } = attribution(null, { scan });
    await expect(subject.attribute('readout')).rejects.toThrow('ps died');
    const reading = await subject.attribute('readout');
    expect(reading?.get(RUN)?.map((p) => p.pid)).toEqual([10]);
  });

  it('attributes nothing when it cannot tell which user it is', async () => {
    const { subject, scan } = attribution([proc(10, 'node a.js')], {
      uid: null,
    });
    expect(await subject.attribute('fresh')).toBeNull();
    expect(scan).not.toHaveBeenCalled();
  });
});
