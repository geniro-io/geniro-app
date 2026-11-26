import { describe, expect, it } from 'vitest';

import { readStopMonitor, stopMonitorResultText } from './stop-monitor.reader';

describe('readStopMonitor', () => {
  it('reads an id shaped like monitor gave it', () => {
    expect(readStopMonitor({ id: ' m2 ' })).toEqual({ id: 'm2' });
  });

  it('reads the id a call sends as monitor_id or monitor', () => {
    expect(readStopMonitor({ monitor_id: 'm1' })).toEqual({ id: 'm1' });
    expect(readStopMonitor({ monitor: 'm1' })).toEqual({ id: 'm1' });
  });

  it('leads each refusal with the right call, then says what was wrong', () => {
    const bad = readStopMonitor({ monitor: '2' });
    expect('error' in bad && bad.error.split('\n')[0]).toBe(
      'call stop_monitor({id: "m1"}).',
    );
    expect('error' in bad && bad.error).toContain('id must look like');
    const clash = readStopMonitor({ id: 'm1', monitor: 'm2' });
    expect('error' in clash && clash.error.split('\n')).toEqual([
      'call stop_monitor({id: "m1"}).',
      'send id once — id and monitor name the same argument and disagree',
    ]);
  });

  it('refuses any other id', () => {
    expect(readStopMonitor({ id: '2' })).toHaveProperty('error');
    expect(readStopMonitor({})).toHaveProperty('error');
  });

  it('says nothing more is sent from a stopped monitor', () => {
    expect(stopMonitorResultText({ status: 'stopped' }, 'm2')).toBe(
      'Stopped monitor m2. Nothing more is sent from it.',
    );
  });

  it('says how a monitor that already ended ended, and that nothing more comes from it', () => {
    expect(
      stopMonitorResultText({ status: 'ended', end: 'exit code 0' }, 'm2'),
    ).toBe(
      'Monitor m2 already ended: exit code 0. Nothing more is sent from it.',
    );
  });
});
