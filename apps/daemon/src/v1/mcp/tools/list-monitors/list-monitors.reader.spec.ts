import { describe, expect, it } from 'vitest';

import {
  listMonitorsResultText,
  readListMonitors,
} from './list-monitors.reader';

describe('readListMonitors', () => {
  it('takes no arguments and refuses one', () => {
    expect(readListMonitors({})).toEqual({});
    expect(readListMonitors({ all: true })).toHaveProperty('error');
  });
});

describe('listMonitorsResultText', () => {
  it('says so when nothing runs, and lists what does in snake_case', () => {
    expect(listMonitorsResultText([])).toBe('No monitor of yours is running.');
    expect(
      JSON.parse(
        listMonitorsResultText([
          {
            id: 'm1',
            description: 'CI',
            command: 'gh run watch 1',
            startedAt: '2026-10-21T00:00:00.000Z',
            endsAt: '2026-10-21T00:10:00.000Z',
            timeoutMs: 600_000,
            events: 2,
            pid: 42,
          },
        ]),
      ),
    ).toEqual([
      {
        id: 'm1',
        description: 'CI',
        command: 'gh run watch 1',
        started_at: '2026-10-21T00:00:00.000Z',
        events: 2,
        timeout_ms: 600_000,
      },
    ]);
  });
});
