import { describe, expect, it } from 'vitest';

import {
  displayRunStatus,
  isSettledRunStatus,
  RUN_STATUS_META,
  type RunStatusKind,
} from './run-status';

describe('displayRunStatus', () => {
  it('reports a live turn as running even when the row still says completed', () => {
    // THE reported flicker. Three writers touch `run.status`, and a snapshot
    // refetch that lands after a fresher event re-asserts a stale `completed`
    // under an agent that is visibly still working. The live plane wins.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('running');
  });

  it('does not invent liveness — a settled row with no live turn is reported as-is', () => {
    // The other half of the same promise: the override must be conditional on
    // `streaming`, not a blanket "always say running".
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(
        displayRunStatus({ status, streaming: false, awaitingAnswer: false }),
      ).toBe(status);
    }
  });

  it('lets failed and cancelled through even mid-stream', () => {
    // Both are settle paths that can arrive before the live plane is torn
    // down. Painting a cancelled run as running would hide the outcome of the
    // thing the user just clicked Stop on.
    expect(
      displayRunStatus({
        status: 'cancelled',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('cancelled');
    expect(
      displayRunStatus({
        status: 'failed',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('failed');
  });

  it('an open question outranks every other signal', () => {
    // The turn IS still open at the daemon while a card waits, so `streaming`
    // and a `running` row both say "busy". Reporting that as running is what
    // left the user watching a spinner that was in fact waiting on them.
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
    // Also from a row that has already gone terminal — a card outliving its
    // row's settle is precisely the "still asking, says completed" case.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: false,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
  });
});

describe('RUN_STATUS_META', () => {
  it('gives needs-input its own non-spinning icon and a readable label', () => {
    // The status word is printed from `label`, so a slug would reach the
    // screen. And the icon must differ from `running`'s: the point of the
    // state is that it will NOT advance on its own, so a second spinner would
    // say the opposite of what it means.
    expect(RUN_STATUS_META['needs-input'].label).toBe('needs more info');
    expect(RUN_STATUS_META['needs-input'].icon).not.toBe(
      RUN_STATUS_META.running.icon,
    );
  });

  it('carries a label and a tone for every kind', () => {
    // The Record is exhaustive by type, but `label` was added later — this
    // catches a kind added with the tone filled in and the label forgotten,
    // which renders as an empty status word rather than a type error.
    const kinds: RunStatusKind[] = [
      'pending',
      'running',
      'needs-input',
      'completed',
      'failed',
      'cancelled',
      'skipped',
      'idle',
    ];
    for (const kind of kinds) {
      expect(RUN_STATUS_META[kind].label, kind).toBeTruthy();
      expect(RUN_STATUS_META[kind].className, kind).toBeTruthy();
    }
  });
});

describe('isSettledRunStatus', () => {
  // Table-driven over EVERY kind, because both directions of getting this
  // wrong are user-visible and silent: widening it to `running` kills the
  // spinner on live work, and narrowing it restores the reported bug — a
  // completed chat with a tool row spinning forever.
  const settled: RunStatusKind[] = [
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ];
  const unsettled: RunStatusKind[] = [
    'pending',
    'running',
    'needs-input',
    'idle',
  ];

  it('reports the four end states as settled', () => {
    for (const kind of settled) {
      expect(isSettledRunStatus(kind), kind).toBe(true);
    }
  });

  it('reports every state a run can still leave as unsettled', () => {
    // `needs-input` is the one worth naming: the turn is OPEN and waiting on a
    // human, so work genuinely is in flight and its spinners must keep
    // running. `pending` and `idle` are states a run has yet to leave, not
    // ones it has finished in.
    for (const kind of unsettled) {
      expect(isSettledRunStatus(kind), kind).toBe(false);
    }
  });

  it('covers every RunStatusKind between the two lists', () => {
    // Without this, a kind added later is silently absent from both lists and
    // the two cases above go on passing while saying nothing about it.
    expect([...settled, ...unsettled].sort()).toEqual(
      Object.keys(RUN_STATUS_META).sort(),
    );
  });
});
