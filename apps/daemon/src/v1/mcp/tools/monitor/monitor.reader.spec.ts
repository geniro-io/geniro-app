import { describe, expect, it } from 'vitest';

import {
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
} from '../../../agents/chat.types';
import { monitorResultText, readMonitor } from './monitor.reader';

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
    expect(monitorResultText({ status: 'started', id: 'm3' })).toMatch(
      /^Started monitor m3\. .*end this turn/,
    );
  });
});
