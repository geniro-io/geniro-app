import { describe, expect, it } from 'vitest';

import {
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
} from '../../../agents/chat.types';
import {
  followsPastItsReader,
  monitorResultText,
  readMonitor,
} from './monitor.reader';

describe('readMonitor', () => {
  it('reads a call, trimming and defaulting the timeout', () => {
    expect(
      readMonitor({ command: '  gh run watch 1  ', description: ' CI ' }),
    ).toEqual({
      command: 'gh run watch 1',
      description: 'CI',
      timeoutMs: MONITOR_TIMEOUT_DEFAULT_MS,
    });
    expect(
      readMonitor({ command: 'true', description: 'x', timeout_ms: 1000 }),
    ).toMatchObject({ timeoutMs: 1000 });
  });

  it('takes a watcher timeout of a whole day', () => {
    expect(MONITOR_TIMEOUT_MAX_MS).toBe(86_400_000);
    for (const timeoutMs of [3_600_001, 86_400_000]) {
      expect(
        readMonitor({
          command: 'true',
          description: 'x',
          timeout_ms: timeoutMs,
        }),
      ).toMatchObject({ timeoutMs });
    }
  });

  it('refuses rather than clamps a timeout out of range', () => {
    for (const timeoutMs of [999, MONITOR_TIMEOUT_MAX_MS + 1, 1500.5]) {
      expect(
        readMonitor({
          command: 'true',
          description: 'x',
          timeout_ms: timeoutMs,
        }),
      ).toEqual({ error: expect.stringContaining('timeout_ms') });
    }
  });

  it('refuses an empty command, a NUL in it, a two-line description and an argument it does not take', () => {
    expect(readMonitor({ command: '', description: 'x' })).toEqual({
      error: expect.stringContaining('command is empty'),
    });
    expect(readMonitor({ command: 'echo \u0000', description: 'x' })).toEqual({
      error: expect.stringContaining('command holds a control character'),
    });
    expect(readMonitor({ command: 'true', description: 'a\nb' })).toEqual({
      error: expect.stringContaining('description must be one line'),
    });
    expect(
      readMonitor({ command: 'true', description: 'x', cwd: '/' }),
    ).toEqual({ error: expect.stringContaining('cwd') });
  });

  it('allows a multi-line command line', () => {
    expect(
      readMonitor({ command: 'echo a\necho b', description: 'x' }),
    ).toMatchObject({
      command: 'echo a\necho b',
    });
  });
});

describe('monitorResultText', () => {
  it('names the id and tells the agent to end its turn', () => {
    expect(
      monitorResultText({ status: 'started', id: 'm3', alsoRunning: [] }),
    ).toMatch(/^Started monitor m3\. .*end this turn rather than wait\.$/);
  });

  it('names the monitors also running, so a replaced one gets stopped', () => {
    const text = monitorResultText({
      status: 'started',
      id: 'm9',
      alsoRunning: [
        { id: 'm8', description: 'PR #7879 4dddef5' },
        { id: 'm2', description: 'stand PR #7879' },
      ],
    });
    expect(text).toMatch(/^Started monitor m9\./);
    expect(text).toContain('m8 (PR #7879 4dddef5), m2 (stand PR #7879)');
    expect(text).toContain('stop_monitor');
  });
});

describe('followsPastItsReader', () => {
  it.each([
    'tail -n +1 -f "$LOG" | grep --line-buffered -m 1 \'^SEED_EXIT=\'; grep -E \'x\' "$LOG"',
    'LOG=a.log; tail -f $LOG | grep -m1 DONE',
    'tail -F a.log | grep --max-count=1 DONE',
    'tail -fn0 a.log | grep -qE "DONE|FAILED"',
    'tail -n 0 -f a.log 2>&1 | egrep --quiet DONE',
    'tail --follow=name a.log | rg -m 1 DONE',
    'tail -50f a.log | head -1',
    "tail -f a.log | sed -n '/DONE/{p;q;}'",
    "tail -f a.log | sed '/DONE/q'",
    "tail -f a.log | awk '/DONE/{print; exit}'",
    'tail -f a.log | grep --line-buffered x | grep -m 1 DONE',
    '(tail -f a.log) | grep -m 1 DONE',
    'cd /x && tail -f a.log \\\n  | grep -m 1 DONE; echo over',
  ])('finds %s', (command) => {
    expect(followsPastItsReader(command)).toBe(true);
  });

  it.each([
    'tail -f app.log | grep --line-buffered ERROR',
    'tail -F a.log | grep --line-buffered -E "^exit=|FAIL"',
    'tail -f a.log | grep --line-buffered "-m 1"',
    'tail -f a.log | grep --line-buffered head',
    "tail -f a.log | sed -u 's/q/x/'",
    'tail -n 5 a.log | head -1',
    'tail -n 5 log-f | grep -m 1 DONE',
    'until grep -q DONE a.log; do sleep 5; done; grep DONE a.log',
    'tail -f a.log; grep -m 1 DONE b.log',
    'tail -f a.log & grep -m 1 DONE b.log',
    'grep -m 1 DONE a.log | tail -f',
    'echo "tail -f a | grep -m 1 x"',
    'gh run watch 12 --exit-status | grep --line-buffered -m 1 failed',
  ])('passes %s', (command) => {
    expect(followsPastItsReader(command)).toBe(false);
  });

  it('refuses such a command, saying what to run instead', () => {
    expect(
      readMonitor({
        command: 'tail -f a.log | grep -m 1 DONE',
        description: 'x',
      }),
    ).toEqual({ error: expect.stringContaining('until grep -q DONE') });
  });
});
