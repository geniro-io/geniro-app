import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentTurnFailure } from '../../agents/adapters/adapter.types';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import type { CalleeTurnOutcome } from '../graphs.types';
import {
  calleeFailedEnvelopeError,
  geniroSideFailure,
  readCalleeFailure,
} from './callee-failure';

const crashed: AgentTurnFailure = { class: 'crashed', resetsAt: null };

/** The adapter's own verdict, as a stub — this util must never reach for one. */
const diagnoseAs = (failure: AgentTurnFailure) => (): AgentTurnFailure =>
  failure;

const outcome = (
  fields: Partial<CalleeTurnOutcome> = {},
): CalleeTurnOutcome => ({
  status: 'failed',
  finalText: null,
  error: null,
  failureClass: null,
  resetsAt: null,
  sessionId: null,
  ...fields,
});

beforeEach(() => {
  clearSecrets();
});

describe('readCalleeFailure', () => {
  it('carries the CLI’s OWN sentence, not a constant', () => {
    // The whole subject. The executor wrote `'callee turn failed'` for every
    // failure there was, so a caller could see that something had gone wrong
    // and never what — which is how a Manager came to re-dispatch five times
    // into a session limit. Revert this file's caller to a fixed string and
    // this assertion is the one that goes red.
    const read = readCalleeFailure(
      "You've hit your session limit · resets 2:30pm (Asia/Almaty)",
      diagnoseAs({ class: 'rate_limited', resetsAt: '2:30pm (Asia/Almaty)' }),
    );

    expect(read.error).toBe(
      "You've hit your session limit · resets 2:30pm (Asia/Almaty)",
    );
    expect(read.failureClass).toBe('rate_limited');
    expect(read.resetsAt).toBe('2:30pm (Asia/Almaty)');
  });

  it('REDACTS the message before it leaves for the caller', () => {
    // A callee's own words cross to a model whose provider is off this machine,
    // so this is the seam where a registered secret must stop. Asserting on the
    // produced string rather than on `redactSecrets` having been called: the
    // observable is what the caller receives.
    registerSecret('sk-live-abcdef123456', 'test-token');

    const read = readCalleeFailure(
      'request failed with token sk-live-abcdef123456',
      diagnoseAs(crashed),
    );

    expect(read.error).not.toContain('sk-live-abcdef123456');
    expect(read.error).toContain('request failed with token');
  });

  it('reads a turn that reported nothing as geniro’s own side', () => {
    // A `failed` outcome comes from an `error` event, which always carries a
    // message — so an empty one means the failure was never the callee's.
    for (const nothing of [null, '', '   ']) {
      const read = readCalleeFailure(nothing, diagnoseAs(crashed));
      expect(read.failureClass).toBe('daemon_restart');
      expect(read.error).toContain('without reporting why');
      expect(read.resetsAt).toBeNull();
    }
  });

  it('falls back to `crashed` when the adapter’s diagnosis THROWS', () => {
    // The defensive branch, entered deliberately. It runs inside the executor's
    // settle `try`, whose `finally` resolves the caller either way — so a throw
    // here skipped the callee's status write and left the node reading
    // `running` for the rest of the run. OBSERVED exactly that way.
    const read = readCalleeFailure('boom', () => {
      throw new Error('adapter exploded');
    });

    expect(read.failureClass).toBe('crashed');
    expect(read.error).toBe('boom');
  });
});

describe('geniroSideFailure', () => {
  it('classifies as `daemon_restart` so the caller retries once', () => {
    // A turn that could not be STARTED, or whose bookkeeping write failed, says
    // nothing about the work — which is a different instruction to a caller
    // than `crashed`, and the reason this is not just the fallback.
    expect(geniroSideFailure('turn start failed: ENOSPC')).toEqual({
      error: 'turn start failed: ENOSPC',
      failureClass: 'daemon_restart',
      resetsAt: null,
    });
  });

  it('redacts too', () => {
    registerSecret('geniro-launch-token', 'test-launch-token');
    expect(
      geniroSideFailure('turn start failed: geniro-launch-token rejected')
        .error,
    ).not.toContain('geniro-launch-token');
  });
});

describe('calleeFailedEnvelopeError', () => {
  it('names the CLASS inside the machine-readable prefix', () => {
    // So a workflow role can be written against `rate_limited` without parsing
    // prose — the arm W6 of the run-efficiency plan needs.
    expect(
      calleeFailedEnvelopeError(
        outcome({ error: 'limit hit', failureClass: 'rate_limited' }),
        'call-3',
      ),
    ).toBe('CALLEE_FAILED[rate_limited]: limit hit');
  });

  it('appends the reset only when the message does not already carry it', () => {
    // claude's own sentence ends `· resets 2:30pm (Asia/Almaty)`, so restating
    // it would read to the caller as two different deadlines.
    expect(
      calleeFailedEnvelopeError(
        outcome({
          error: "You've hit your session limit · resets 2:30pm",
          failureClass: 'rate_limited',
          resetsAt: '2:30pm',
        }),
        'call-3',
      ),
    ).toBe(
      "CALLEE_FAILED[rate_limited]: You've hit your session limit · resets 2:30pm",
    );

    expect(
      calleeFailedEnvelopeError(
        outcome({
          error: 'quota exhausted',
          failureClass: 'rate_limited',
          resetsAt: 'tomorrow 09:00',
        }),
        'call-3',
      ),
    ).toBe(
      'CALLEE_FAILED[rate_limited]: quota exhausted — resets tomorrow 09:00',
    );
  });

  it('still says something for an outcome carrying neither', () => {
    expect(calleeFailedEnvelopeError(outcome(), 'call-3')).toBe(
      'CALLEE_FAILED[crashed]: the callee turn ended without reporting why — this is geniro’s own side, not the callee',
    );
  });

  it('names the thread that continues the crashed conversation', () => {
    // The whole of run `ce63c362`: three QA reviews of one diff crashed on
    // transport failures and the caller re-dispatched each as a BARE call,
    // restarting a twenty-minute review from nothing three times. The resume
    // handle existed every time — it is what `sessionId` is.
    expect(
      calleeFailedEnvelopeError(
        outcome({
          error: 'Error: RetriableError: Connection stalled',
          failureClass: 'crashed',
          sessionId: '7e6db012-458a-40c0-8251-4458306ecce5',
        }),
        'call-15',
      ),
    ).toBe(
      "CALLEE_FAILED[crashed]: Error: RetriableError: Connection stalled — its conversation survives: thread: 'call-15' continues it instead of starting over",
    );
  });

  it('says nothing about a thread when the turn recorded no session', () => {
    // A turn that died before its CLI opened a conversation has no handle, and
    // naming one would send the caller into a refusal it cannot act on.
    expect(
      calleeFailedEnvelopeError(
        outcome({ error: 'spawn failed', failureClass: 'daemon_restart' }),
        'call-4',
      ),
    ).toBe('CALLEE_FAILED[daemon_restart]: spawn failed');
  });

  it('offers the thread to every class, without telling them all to retry', () => {
    // The four classes want four different next moves — `rate_limited` waits,
    // `auth_expired` stops — and all four want the conversation when they do
    // move. So this is a fact about the thread, never an instruction to retry.
    for (const cls of [
      'rate_limited',
      'auth_expired',
      'daemon_restart',
      'crashed',
    ] as const) {
      const said = calleeFailedEnvelopeError(
        outcome({ error: 'it broke', failureClass: cls, sessionId: 's-1' }),
        'call-9',
      );
      expect(said).toContain("thread: 'call-9'");
      expect(said).not.toMatch(/retry|try again/i);
    }
  });
});
