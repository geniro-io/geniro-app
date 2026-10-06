import { readFileSync } from 'node:fs';

import { atomicWriteSync } from '../../../../../utils/atomic-file';
import { asNumber, asRecord } from '../../../utils/json-util';

/** One session's running totals, as the last `result` line stated them. */
export interface ClaudeSessionTotals {
  costUsd: number | null;
  apiMs: number | null;
}

/**
 * Where {@link ClaudeSessionCostLedger}'s per-session totals outlive the
 * daemon — `<userData>/claude-session-costs.json`.
 *
 * The ledger turns claude's RUNNING total into per-turn figures by subtracting
 * the last total it saw, and a daemon restart used to empty it. The next
 * process of every session then either billed the whole restored history again
 * (the defect behind $2,141 of `/compact` turns in a month) or, once that was
 * guarded, started from the transcript's own `cost-state` — which drops what the
 * previous process spent after its last result: a stopped turn reports no cost
 * of its own, and background sub-agents keep spending after the turn's result.
 * Measured on a real profile: $402 of stopped turns and $2,793 of work outside
 * any turn in a month. A total that survives the restart keeps both, because
 * the next result's step is billed against it.
 */
export class ClaudeCostTotalsFile {
  constructor(private readonly path: string) {}

  /** Every remembered session, oldest first; empty for a missing or unreadable file. */
  read(): [string, ClaudeSessionTotals][] {
    try {
      const value = asRecord(JSON.parse(readFileSync(this.path, 'utf8')));
      const out: [string, ClaudeSessionTotals][] = [];
      for (const [sessionId, entry] of Object.entries(value ?? {})) {
        const totals = asRecord(entry);
        if (totals !== null) {
          out.push([
            sessionId,
            {
              costUsd: asNumber(totals.costUsd),
              apiMs: asNumber(totals.apiMs),
            },
          ]);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Replace the file with these entries. Never throws — a lost write costs one restart's precision. */
  write(entries: Iterable<[string, ClaudeSessionTotals]>): void {
    try {
      atomicWriteSync(this.path, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // The in-memory ledger is still right for this daemon's lifetime.
    }
  }
}
