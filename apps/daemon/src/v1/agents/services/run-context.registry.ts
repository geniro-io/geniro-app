import { Injectable } from '@nestjs/common';

/** One run's latest context reading, as the CLI last reported it. */
export interface RunContextReading {
  tokens: number | null;
  window: number | null;
}

/**
 * The newest context reading per run, so every status broadcast can carry it.
 *
 * WHY THIS EXISTS. `Run.contextTokens` is written on every reading and is
 * therefore always right ON THE DAEMON — but a client only ever learns it two
 * ways: the `GET /v1/chats` list it fetched when its window opened, and the
 * live `context_progress` deltas of the ONE run it has joined. A thread working
 * while the user is on another chat matches neither, so that client's copy of
 * the row froze at whatever the list said and the ring drew a figure that could
 * be an hour old. REPORTED as "запустил тред, он отработал где-то час, и я
 * обратно за него захожу … контекст совсем маленький, но как только я на него
 * навожу, он через несколько секунд обновляется" — the hover is the readout
 * asking the live CLI (1.2–3.3s), which is the only thing that was correcting
 * it.
 *
 * The fix is the one `run_status` already applies to a run's STATUS, its
 * summary, its preview and its title: broadcast it to every client rather than
 * to the room of the run in focus. This holds the value so the broadcast can
 * carry it without any producer having to know about it — see
 * {@link AgentEventBus.publishRunStatus}, which stamps every status event from
 * here. No new event and no new cadence: a working run announces itself on
 * every tool call, and a settling one always announces, which is the moment
 * after which the figure cannot move again.
 *
 * In memory and per LAUNCH, like {@link ProcessRegistry} beside it. A daemon
 * that has just started holds nothing, so its first announces carry no reading
 * and the client keeps the row its list fetch gave it — which is correct, since
 * that row came from the same database this would have been read out of.
 */
@Injectable()
export class RunContextRegistry {
  private readonly readings = new Map<string, RunContextReading>();

  /**
   * File what the CLI just reported for one run.
   *
   * MERGED rather than replaced, and each half independently: the two figures
   * arrive on different lines. claude names the WINDOW only on its result line
   * and never on an assistant one, so a mid-turn reading carries a count with
   * no denominator — and overwriting the window with that null would leave the
   * ring a numerator with nothing to scale against, which is exactly the state
   * `RunDao.rememberContext` refuses to write for the same reason.
   */
  remember(runId: string, reading: Partial<RunContextReading>): void {
    const current = this.readings.get(runId);
    const next: RunContextReading = {
      tokens: reading.tokens ?? current?.tokens ?? null,
      window: reading.window ?? current?.window ?? null,
    };
    if (next.tokens === null && next.window === null) {
      return;
    }
    this.readings.set(runId, next);
  }

  /**
   * Drop the count while keeping the window — what a COMPACTION leaves behind.
   *
   * The conversation the count measured is gone, so it is no longer true of
   * anything; the window belongs to the MODEL and is unchanged by a compaction,
   * and it is what lets the emptied ring still be drawn as a gauge. The twin of
   * `RunDao.forgetContext`, and it exists so the two cannot disagree: a stamped
   * announce carrying the pre-compaction count would put it straight back on
   * every client that had just cleared it.
   */
  forgetTokens(runId: string): void {
    const current = this.readings.get(runId);
    if (current === undefined) {
      return;
    }
    if (current.window === null) {
      this.readings.delete(runId);
      return;
    }
    this.readings.set(runId, { tokens: null, window: current.window });
  }

  /** What to stamp on this run's next status broadcast, or null for nothing. */
  read(runId: string): RunContextReading | null {
    return this.readings.get(runId) ?? null;
  }

  /** The run is gone — see `ChatService.delete`, which owns the teardown. */
  forget(runId: string): void {
    this.readings.delete(runId);
  }
}
