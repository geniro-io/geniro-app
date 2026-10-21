import { describe, expect, it } from 'vitest';

import { readMonitorNotice } from './monitor-payload';

const entry = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'm1',
  description: 'dev server log',
  event: 'batch',
  lines: ['ready on :3000'],
  omitted: 0,
  ...over,
});

const notice = (
  monitors: unknown,
  woke: unknown = true,
): Record<string, unknown> => ({
  severity: 'info',
  message: 'monitor m1',
  monitors,
  woke,
});

describe('readMonitorNotice', () => {
  it('reads a batch with its lines and what was cut', () => {
    expect(readMonitorNotice(notice([entry({ omitted: 4 })], true))).toEqual({
      woke: true,
      monitors: [
        {
          id: 'm1',
          description: 'dev server log',
          event: 'batch',
          end: null,
          lines: ['ready on :3000'],
          omitted: 4,
        },
      ],
    });
  });

  it('reads a row that did not wake the agent', () => {
    expect(
      readMonitorNotice(notice([entry({ event: 'end' })], false))?.woke,
    ).toBe(false);
  });

  it.each([
    [
      { kind: 'exit', code: 0 },
      { kind: 'exit', code: 0 },
    ],
    [
      { kind: 'exit', code: 2 },
      { kind: 'exit', code: 2 },
    ],
    [
      { kind: 'signal', signal: 'SIGKILL' },
      { kind: 'signal', signal: 'SIGKILL' },
    ],
    [{ kind: 'timeout' }, { kind: 'timeout' }],
    [{ kind: 'stopped' }, { kind: 'stopped' }],
    [{ kind: 'flooded' }, { kind: 'flooded' }],
    [{ kind: 'interrupted' }, { kind: 'interrupted' }],
  ])('reads the ending %j', (end, expected) => {
    const read = readMonitorNotice(
      notice([entry({ event: 'end', end, lines: [] })]),
    );
    expect(read?.monitors[0]?.end).toEqual(expected);
  });

  it('drops a malformed entry and keeps the others', () => {
    const read = readMonitorNotice(
      notice([
        entry({ id: 'm1' }),
        entry({ id: '' }),
        entry({ id: 'm3', event: 'tick' }),
        entry({ id: 'm4', lines: [1] }),
        entry({ id: 'm5', omitted: -1 }),
        entry({ id: 'm6', end: { kind: 'vanished' } }),
        null,
        'm7',
      ]),
    );
    expect(read?.monitors.map((m) => m.id)).toEqual(['m1']);
  });

  it('answers null for anything that is not a monitor notice', () => {
    expect(readMonitorNotice(null)).toBeNull();
    expect(readMonitorNotice('monitor')).toBeNull();
    expect(readMonitorNotice({ message: 'plain notice' })).toBeNull();
    expect(readMonitorNotice(notice('m1'))).toBeNull();
    expect(readMonitorNotice(notice([]))).toBeNull();
    expect(readMonitorNotice(notice([entry({ event: 'tick' })]))).toBeNull();
  });
});
