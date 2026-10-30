import { Injectable } from '@nestjs/common';

/** What a chat's open turn has spent not working, and where a stretch of the CLI's own began. */
export interface RunHoldReading {
  /** When the CLI woke for a stretch of its own, or null for a turn of ours. */
  startedAt: number | null;
  /** Holds that have ended, summed. */
  heldMs: number;
  /** When the hold still standing began, or null when none stands. */
  heldSince: number | null;
}

const NONE: RunHoldReading = { startedAt: null, heldMs: 0, heldSince: null };

/**
 * The holds of each chat's OPEN turn — the stretches the agent spent waiting
 * on background work it launched, which its worked time leaves out — and,
 * for a stretch the CLI runs by itself, when it woke for it.
 *
 * Kept by the daemon because neither leaves a row: a window that opens or
 * reloads mid-turn can learn them only from here. A turn of ours starting, a
 * stretch starting and a settle each start the reading over.
 *
 * In memory and per launch: both die with the CLI process, and so does every
 * turn they could belong to.
 */
@Injectable()
export class RunHoldRegistry {
  private readonly readings = new Map<string, RunHoldReading>();

  startStretch(runId: string, at: number): void {
    this.readings.set(runId, { ...NONE, startedAt: at });
  }

  hold(runId: string, open: number, now = Date.now()): void {
    const reading = this.readings.get(runId) ?? NONE;
    if (open > 0 && reading.heldSince === null) {
      this.readings.set(runId, { ...reading, heldSince: now });
    } else if (open === 0 && reading.heldSince !== null) {
      this.readings.set(runId, {
        ...reading,
        heldMs: reading.heldMs + Math.max(0, now - reading.heldSince),
        heldSince: null,
      });
    }
  }

  read(runId: string): RunHoldReading {
    return this.readings.get(runId) ?? NONE;
  }

  forget(runId: string): void {
    this.readings.delete(runId);
  }
}
