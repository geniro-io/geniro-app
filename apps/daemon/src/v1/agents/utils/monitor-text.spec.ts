import { describe, expect, it } from 'vitest';

import type { HostRowWire, MonitorRowPayload } from '../chat.types';
import {
  type MonitorMessage,
  monitorMessageText,
  promptNamingRunning,
  type StoppedMonitor,
  stoppedMonitorLine,
  stoppedMonitorsText,
  wakesOnMonitorProgress,
} from './monitor-text';

const message = (kind: 'stopped' | 'timeout') => ({
  id: 'm2',
  description: 'long wait',
  batch: { lines: [], omitted: 0 },
  end: { kind },
});

describe('monitorMessageText', () => {
  it('tells the agent the user stopped its monitor from the process panel', () => {
    const text = monitorMessageText(message('stopped'));
    expect(text).toContain(
      '<message from="long wait · monitor · stopped" monitor="m2">',
    );
    expect(text).toContain('The user stopped it from the process panel.');
  });

  it('names no one for an end that is not a stop', () => {
    expect(monitorMessageText(message('timeout'))).not.toContain('The user');
  });
});

describe('promptNamingRunning', () => {
  it('leaves the prompt alone when nothing runs', () => {
    expect(promptNamingRunning('output', [])).toBe('output');
  });

  it('names each running monitor after the output and how to stop it', () => {
    const text = promptNamingRunning('output', [
      { id: 'm1', description: 'seed run' },
      { id: 'm2', description: 'CI' },
    ]);
    expect(text.startsWith('output\n\n[geniro] Still running:')).toBe(true);
    expect(text).toContain('m1 (seed run), m2 (CI)');
    expect(text).toContain('stop_monitor');
  });
});

describe('wakesOnMonitorProgress', () => {
  const entry = (event: MonitorRowPayload['event']): MonitorRowPayload => ({
    id: 'm1',
    description: 'CI',
    event,
    lines: [],
    omitted: 0,
  });
  const row = (fields: Partial<HostRowWire>): HostRowWire => ({
    severity: 'info',
    message: '',
    woke: true,
    ...fields,
  });

  it('is true only while every monitor the row names is still running', () => {
    expect(
      wakesOnMonitorProgress(
        row({ monitors: [entry('batch'), entry('batch')] }),
      ),
    ).toBe(true);
    expect(
      wakesOnMonitorProgress(row({ monitors: [entry('batch'), entry('end')] })),
    ).toBe(false);
  });

  it('is false for a row that names no monitor batch', () => {
    expect(wakesOnMonitorProgress(row({ monitors: [] }))).toBe(false);
    expect(
      wakesOnMonitorProgress(
        row({ threadWake: { fromRunId: 'r2', fromTitle: 'Other' } }),
      ),
    ).toBe(false);
  });
});

describe('stoppedMonitorLine', () => {
  const stopped: StoppedMonitor = {
    id: 'm1',
    description: 'CI',
    command: 'npm run watch',
    remainingMs: 360_000,
  };

  it('names the monitor, its description, its command and about how long it had left', () => {
    expect(stoppedMonitorLine(stopped)).toBe(
      'm1 — CI — `npm run watch` (~6 min were left)',
    );
  });

  it('says its timeout had passed when nothing was left', () => {
    expect(stoppedMonitorLine({ ...stopped, remainingMs: 0 })).toBe(
      'm1 — CI — `npm run watch` (its timeout had passed)',
    );
  });

  it('says the command was not recorded, and names no time when none is known', () => {
    expect(
      stoppedMonitorLine({ ...stopped, command: null, remainingMs: null }),
    ).toBe('m1 — CI — command not recorded — see your earlier monitor call');
  });

  it('rounds the time left to whole minutes and never reads under one', () => {
    expect(stoppedMonitorLine({ ...stopped, remainingMs: 90_000 })).toBe(
      'm1 — CI — `npm run watch` (~2 min were left)',
    );
    expect(stoppedMonitorLine({ ...stopped, remainingMs: 1_000 })).toBe(
      'm1 — CI — `npm run watch` (~1 min were left)',
    );
  });
});

describe('stoppedMonitorsText', () => {
  it('says the monitors were not started again, names each one, and what to do', () => {
    expect(
      stoppedMonitorsText([
        {
          id: 'm1',
          description: 'CI',
          command: 'npm run watch',
          remainingMs: 360_000,
        },
        { id: 'm2', description: 'build', command: null, remainingMs: null },
      ]),
    ).toBe(
      'Stopped monitors (not started again): m1 — CI — `npm run watch` (~6 min were left); m2 — build — command not recorded — see your earlier monitor call; start them again with monitor if you still need them.',
    );
  });
});

describe('monitorMessageText for a monitor a restart stopped', () => {
  const interrupted = (stopped?: StoppedMonitor): MonitorMessage => ({
    id: 'm1',
    description: 'CI',
    batch: { lines: [], omitted: 0 },
    end: { kind: 'interrupted' },
    ...(stopped === undefined ? {} : { stopped }),
  });

  it('tells the agent it was not started again, with its command and the time it had left', () => {
    const text = monitorMessageText(
      interrupted({
        id: 'm1',
        description: 'CI',
        command: 'npm run watch',
        remainingMs: 360_000,
      }),
    );
    expect(text).toContain(
      'It was not started again: m1 — CI — `npm run watch` (~6 min were left). Start it again with monitor if you still need it.',
    );
  });

  it('names no restart for an interrupted end that carries no stopped monitor', () => {
    expect(monitorMessageText(interrupted())).not.toContain(
      'not started again',
    );
  });
});
