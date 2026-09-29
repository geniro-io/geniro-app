import { describe, expect, it } from 'vitest';

import type { PersistedResetWake } from '../chat.types';
import {
  readPersistedResetWakes,
  readRunResetWakes,
  resetWakesWire,
} from './run-reset-wakes';

const WAKE: PersistedResetWake = {
  instant: 1_000,
  continuesAt: 61_000,
  resetsAt: '6:10pm (UTC)',
  owners: [
    {
      owner: 'orch',
      calls: [
        { callId: 'call-1', callee: 'Engineer' },
        { callId: 'call-2', callee: 'QA' },
      ],
    },
  ],
};

describe('the run row’s promised continues', () => {
  it('reads back exactly what was written', () => {
    expect(readPersistedResetWakes(JSON.stringify([WAKE]))).toEqual([WAKE]);
  });

  it('answers none for an empty column, and for one that does not parse', () => {
    // A row a newer or older build wrote must cost its promises, never the
    // run's listing.
    expect(readPersistedResetWakes(null)).toEqual([]);
    expect(readPersistedResetWakes('')).toEqual([]);
    expect(readPersistedResetWakes('{not json')).toEqual([]);
    expect(readPersistedResetWakes('{"instant":1}')).toEqual([]);
  });

  it('drops a promise that cannot say when, or whom it continues', () => {
    const noWhen = { ...WAKE, continuesAt: 'later' };
    const noOwner = { ...WAKE, owners: [{ calls: WAKE.owners[0]!.calls }] };
    const noCalls = { ...WAKE, owners: [{ owner: 'orch', calls: [] }] };
    expect(
      readPersistedResetWakes(JSON.stringify([noWhen, noOwner, noCalls, WAKE])),
    ).toEqual([WAKE]);
  });

  it('tells the renderer when, in whose words, and which calls', () => {
    expect(resetWakesWire([WAKE])).toEqual([
      {
        instant: 1_000,
        continuesAt: 61_000,
        resetsAt: '6:10pm (UTC)',
        callIds: ['call-1', 'call-2'],
      },
    ]);
    expect(readRunResetWakes(null)).toEqual([]);
  });
});
