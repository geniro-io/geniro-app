import { describe, expect, it } from 'vitest';

import { readStopMonitor, stopMonitorResultText } from './stop-monitor.reader';

describe('readStopMonitor', () => {
  it('reads an id shaped like monitor gave it', () => {
    expect(readStopMonitor({ id: ' m2 ' })).toEqual({ id: 'm2' });
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
});
