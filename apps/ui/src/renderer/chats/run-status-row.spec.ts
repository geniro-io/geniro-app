import { describe, expect, it } from 'vitest';

import type { RunStatusEvent } from '../daemon-client';
import { runStatusRowFields } from './run-status-row';

const announce = (patch: Partial<RunStatusEvent> = {}): RunStatusEvent => ({
  runId: 'run-1',
  status: null,
  ...patch,
});

describe('runStatusRowFields', () => {
  it('asserts nothing for an announce that carries none of its fields', () => {
    expect(runStatusRowFields(announce())).toEqual({});
  });

  it('keeps the row status on a null status, and sets it otherwise', () => {
    expect(runStatusRowFields(announce({ status: null }))).not.toHaveProperty(
      'status',
    );
    expect(runStatusRowFields(announce({ status: 'completed' }))).toEqual({
      status: 'completed',
    });
  });

  it('clears awaiting on null, and leaves it alone when absent', () => {
    expect(runStatusRowFields(announce())).not.toHaveProperty('awaiting');
    expect(runStatusRowFields(announce({ awaiting: null }))).toEqual({
      awaiting: null,
    });
  });

  it('writes a zero holding count, which says the hold is over', () => {
    expect(runStatusRowFields(announce({ holdingFor: 0 }))).toEqual({
      holdingFor: 0,
    });
  });

  it('writes both clocks from the one timestamp', () => {
    expect(
      runStatusRowFields(announce({ at: '2026-10-09T10:00:00.000Z' })),
    ).toEqual({
      updatedAt: '2026-10-09T10:00:00.000Z',
      lastActivityAt: '2026-10-09T10:00:00.000Z',
    });
  });

  it('writes an empty task list, and leaves the list alone when absent', () => {
    expect(runStatusRowFields(announce({ taskList: [] }))).toEqual({
      taskList: [],
    });
    expect(runStatusRowFields(announce())).not.toHaveProperty('taskList');
  });
});
