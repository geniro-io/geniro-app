import { Injectable } from '@nestjs/common';

import { environment } from '../../../environments';
import {
  attributeRunProcesses,
  runOwnerOf,
  type ScannedProcess,
  scanProcessTable,
} from '../utils/run-process-scan';

/**
 * How old a scan a READOUT may be served. The environment of every process
 * is megabytes of text; a panel polling every few seconds shares one reading,
 * and a process that detached a moment ago shows up within this long.
 */
export const READOUT_SCAN_MAX_AGE_MS = 10_000;

/**
 * This geniro's owner tag. The one source of it: the registry stamps it on
 * every spawn and {@link RunProcessAttribution} searches by it, and a tag that
 * the search reads differently from how it was stamped matches nothing.
 */
export function currentRunOwner(): string {
  return runOwnerOf(environment.userDataDir);
}

/** Test seams — the production factory passes none. */
export interface RunProcessAttributionOptions {
  scan?: () => Promise<ScannedProcess[] | null>;
  selfPid?: number;
  /** Null when the platform cannot say — and then nothing is attributed. */
  uid?: number | null;
  now?: () => number;
}

/**
 * The ONE answer to "which processes are each run's", for the usage readout,
 * the archive/delete reap and the leftover sweep alike (`attributeRunProcesses`
 * over a scan of the table, scoped to this geniro, this user, never the daemon).
 */
@Injectable()
export class RunProcessAttribution {
  private readonly scan: () => Promise<ScannedProcess[] | null>;
  private readonly selfPid: number;
  private readonly uid: number | null;
  private readonly now: () => number;
  private memo: {
    at: number;
    reading: Promise<Map<string, ScannedProcess[]> | null>;
  } | null = null;

  constructor(
    readonly owner: string,
    options: RunProcessAttributionOptions = {},
  ) {
    this.scan = options.scan ?? scanProcessTable;
    this.selfPid = options.selfPid ?? process.pid;
    this.uid =
      options.uid !== undefined ? options.uid : (process.getuid?.() ?? null);
    this.now = options.now ?? Date.now;
  }

  /**
   * Each run's processes, or null when the table could not be read. A kill
   * asks `fresh`; a readout may be served a reading up to
   * {@link READOUT_SCAN_MAX_AGE_MS} old.
   */
  attribute(
    freshness: 'fresh' | 'readout',
  ): Promise<Map<string, ScannedProcess[]> | null> {
    const memo = this.memo;
    if (
      freshness === 'readout' &&
      memo !== null &&
      this.now() - memo.at < READOUT_SCAN_MAX_AGE_MS
    ) {
      return memo.reading;
    }
    const reading = this.read();
    this.memo = { at: this.now(), reading };
    // A failed reading is not served to the next readout.
    reading.catch(() => {
      if (this.memo?.reading === reading) {
        this.memo = null;
      }
    });
    return reading;
  }

  private async read(): Promise<Map<string, ScannedProcess[]> | null> {
    if (this.uid === null) {
      return null;
    }
    const rows = await this.scan();
    if (rows === null) {
      return null;
    }
    return attributeRunProcesses(rows, {
      owner: this.owner,
      selfPid: this.selfPid,
      uid: this.uid,
    });
  }
}
