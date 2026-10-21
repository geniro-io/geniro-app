import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import {
  mergeMonitorBatch,
  MONITOR_EVENT_MAX_BYTES,
  MONITOR_EVENT_MAX_LINES,
  MONITOR_FLOOD_MAX_LINES,
  MONITOR_FLOOD_WINDOW_MS,
  MonitorBatcher,
} from './monitor-batcher';

function numbered(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `${from + i}`).join('\n');
}

describe('MonitorBatcher', () => {
  it('joins a line split across chunks and hands an unfinished one over only at the end', () => {
    const batcher = new MonitorBatcher();
    batcher.push('hel');
    batcher.push('lo\nwor');
    expect(batcher.take()).toEqual({ lines: ['hello'], omitted: 0 });
    expect(batcher.take()).toBeNull();
    batcher.push('ld');
    expect(batcher.take(true)).toEqual({ lines: ['world'], omitted: 0 });
  });

  it('splits 250 lines into events of ≤100 lines and ≤16 KiB with an omitted tail', () => {
    const batcher = new MonitorBatcher();
    batcher.push(`${numbered(250)}\n`);
    const batch = batcher.take();
    expect(batch?.lines).toHaveLength(MONITOR_EVENT_MAX_LINES);
    expect(batch?.lines[99]).toBe('100');
    expect(batch?.omitted).toBe(150);

    const wide = new MonitorBatcher();
    const line = 'x'.repeat(900);
    wide.push(`${Array.from({ length: 40 }, () => line).join('\n')}\n`);
    const capped = wide.take();
    const bytes = (capped?.lines ?? []).reduce(
      (sum, kept) => sum + Buffer.byteLength(kept) + 1,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MONITOR_EVENT_MAX_BYTES);
    // 18 lines of 901 bytes fit in 16 KiB; the 22 after them are counted.
    expect(capped?.lines).toHaveLength(18);
    expect(capped?.omitted).toBe(22);
  });

  it('stops on >1000 lines in 10 s and carries the unsent lines in the flooded end', () => {
    let now = 0;
    const batcher = new MonitorBatcher(() => now);
    expect(batcher.push(`${numbered(600)}\n`)).toBe('ok');
    now += MONITOR_FLOOD_WINDOW_MS / 2;
    expect(
      batcher.push(`${numbered(MONITOR_FLOOD_MAX_LINES - 599, 601)}\n`),
    ).toBe('flooded');
    const end = batcher.take(true);
    expect(end?.lines[0]).toBe('1');
    expect((end?.lines.length ?? 0) + (end?.omitted ?? 0)).toBe(1001);
  });

  it('stops on more than 256 KiB in 10 s even under the line limit', () => {
    const batcher = new MonitorBatcher(() => 0);
    const line = 'x'.repeat(1000);
    expect(
      batcher.push(`${Array.from({ length: 200 }, () => line).join('\n')}\n`),
    ).toBe('ok');
    expect(
      batcher.push(`${Array.from({ length: 100 }, () => line).join('\n')}\n`),
    ).toBe('flooded');
  });

  it('forgets output older than the flood window', () => {
    let now = 0;
    const batcher = new MonitorBatcher(() => now);
    expect(batcher.push(`${numbered(900)}\n`)).toBe('ok');
    now += MONITOR_FLOOD_WINDOW_MS + 1;
    expect(batcher.push(`${numbered(900)}\n`)).toBe('ok');
  });

  it('strips ANSI and cuts a 5000-char line to 1000 with … (+4000 characters)', () => {
    const batcher = new MonitorBatcher();
    batcher.push('\u001b[31mred\u001b[0m ok\n');
    batcher.push(`${'y'.repeat(2500)}`);
    batcher.push(`${'y'.repeat(2500)}\n`);
    expect(batcher.take()?.lines).toEqual([
      'red ok',
      `${'y'.repeat(1000)} … (+4000 characters)`,
    ]);
  });

  it('keeps only what a carriage-return redraw leaves on screen, and drops a CRLF ending', () => {
    const batcher = new MonitorBatcher();
    batcher.push('10%\r50%\r100%\ndone\r\n');
    expect(batcher.take()?.lines).toEqual(['100%', 'done']);
  });
});

describe('MonitorBatcher — secrets', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('masks a registered secret in a line, also one straddling the cut', () => {
    const secret = 'sk-live-0123456789abcdef';
    registerSecret(secret, 'test token');
    const batcher = new MonitorBatcher();
    batcher.push(`token=${secret}\n`);
    batcher.push(`${'y'.repeat(990)}${secret}\n`);
    const lines = batcher.take()?.lines ?? [];
    expect(lines.join('\n')).not.toContain('sk-live-');
    expect(lines[0]).toMatch(/^token=/);
  });
});

describe('MonitorBatcher — redraws split across chunks', () => {
  it('keeps only the last redraw when each update arrives in its own chunk', () => {
    const batcher = new MonitorBatcher();
    batcher.push('10%\r');
    batcher.push('50%\r');
    batcher.push('done\n');
    expect(batcher.take()?.lines).toEqual(['done']);
  });

  it('still reads a CRLF split between two chunks as one line ending', () => {
    const batcher = new MonitorBatcher();
    batcher.push('line\r');
    batcher.push('\nnext\n');
    expect(batcher.take()?.lines).toEqual(['line', 'next']);
  });
});

describe('mergeMonitorBatch', () => {
  it('folds a later batch into a held one under the same caps, never leaving a hole', () => {
    const held = { lines: ['a', 'b'], omitted: 0 };
    expect(mergeMonitorBatch(held, { lines: ['c'], omitted: 2 })).toEqual({
      lines: ['a', 'b', 'c'],
      omitted: 2,
    });
    const full = {
      lines: Array.from({ length: MONITOR_EVENT_MAX_LINES }, () => 'z'),
      omitted: 3,
    };
    expect(mergeMonitorBatch(full, { lines: ['late'], omitted: 0 })).toEqual({
      lines: full.lines,
      omitted: 4,
    });
  });
});
