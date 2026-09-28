import type { PersistedResetWake, RunResetWake } from '../chat.types';
import { asArray, asNumber, asRecord, asString } from './json-util';

/**
 * The run row's pending usage-limit continues (`Run.resetWakes`), read back
 * DEFENSIVELY: the column is TEXT this daemon wrote, but a row written by an
 * older build, or hand-edited, must cost the entries it cannot read rather than
 * the run's listing. An unreadable wake is dropped whole — a continue that
 * cannot say whom it continues is one nothing can deliver.
 */
export function readPersistedResetWakes(
  json: string | null,
): PersistedResetWake[] {
  if (json === null || json === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return asArray(parsed).flatMap((entry): PersistedResetWake[] => {
    const wake = asRecord(entry);
    const instant = asNumber(wake?.instant);
    const continuesAt = asNumber(wake?.continuesAt);
    const resetsAt = asString(wake?.resetsAt);
    if (instant === null || continuesAt === null || resetsAt === null) {
      return [];
    }
    const owners = asArray(wake?.owners).flatMap((row) => {
      const record = asRecord(row);
      const owner = asString(record?.owner);
      if (owner === null) {
        return [];
      }
      const calls = asArray(record?.calls).flatMap((call) => {
        const item = asRecord(call);
        const callId = asString(item?.callId);
        const callee = asString(item?.callee);
        return callId === null || callee === null ? [] : [{ callId, callee }];
      });
      return calls.length === 0 ? [] : [{ owner, calls }];
    });
    return owners.length === 0
      ? []
      : [{ instant, continuesAt, resetsAt, owners }];
  });
}

/** What the renderer is told: when, in whose words, and which calls. */
export function resetWakesWire(
  wakes: readonly PersistedResetWake[],
): RunResetWake[] {
  return wakes.map((wake) => ({
    instant: wake.instant,
    continuesAt: wake.continuesAt,
    resetsAt: wake.resetsAt,
    callIds: wake.owners.flatMap((owner) =>
      owner.calls.map((call) => call.callId),
    ),
  }));
}

/** The column straight to the wire, for the run's listing. */
export function readRunResetWakes(json: string | null): RunResetWake[] {
  return resetWakesWire(readPersistedResetWakes(json));
}
