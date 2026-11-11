import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';

import { environment } from '../../../environments';
import { MemoryUsageDao } from '../dao/memory-usage.dao';
import type { MemoryUsageField } from '../memory.types';
import { usesOf } from '../utils/memory-usage-day';

/**
 * Bumped to have the backfill run again over every run it has not recorded
 * as counted; runs already counted stay counted.
 */
export const MEMORY_USAGE_BACKFILL_VERSION = 1;

/**
 * `<userData>/` file holding the usage ledger's cutoff — the instant live
 * counting began, written before the first live count — and the backfill
 * version that finished, as JSON.
 */
export const MEMORY_USAGE_MARKER_FILE = 'memory-usage-backfill';

export interface MemoryUsageMarker {
  /** Epoch ms. A use before it is the backfill's to count, one after it live counting's. */
  cutoff: number;
  /** The {@link MEMORY_USAGE_BACKFILL_VERSION} whose pass finished, or null. */
  doneVersion: number | null;
}

/**
 * Counts how agents use each shared-memory entry (`memory_usage_days`) as it
 * happens. A count that fails is logged and lost; it never reaches the tool
 * answer or the run start that caused it.
 *
 * Live counting starts only once the cutoff is durable, so every use is on
 * exactly one side of it: the backfill counts history strictly before it.
 * When the marker cannot be written, this launch counts nothing live and the
 * next launch's cutoff leaves those uses to the backfill.
 */
@Injectable()
export class MemoryUsageService implements OnModuleInit {
  private readonly logger = new Logger(MemoryUsageService.name);
  private readonly markerPath: string;
  private live = false;
  private marker: MemoryUsageMarker | null = null;

  constructor(
    private readonly usage: MemoryUsageDao,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath =
      markerPath ?? join(environment.userDataDir, MEMORY_USAGE_MARKER_FILE);
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  /** Read the marker, or take the cutoff now when there is none. */
  async start(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.markerPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`memory usage marker not read: ${errorText(err)}`);
        this.live = true;
        return;
      }
      await this.takeCutoff();
      return;
    }
    this.marker = parseMarker(text);
    if (this.marker === null) {
      this.logger.warn(
        'memory usage marker is unreadable; the backfill will not run',
      );
    }
    this.live = true;
  }

  /** The cutoff and finished backfill version, or null when unknown. */
  get backfillMarker(): MemoryUsageMarker | null {
    return this.marker;
  }

  /** Record that the backfill finished under the current version. */
  async markBackfilled(): Promise<void> {
    if (this.marker === null) {
      return;
    }
    const next = {
      ...this.marker,
      doneVersion: MEMORY_USAGE_BACKFILL_VERSION,
    };
    try {
      await this.write(next);
      this.marker = next;
    } catch (err) {
      this.logger.warn(
        `could not record the memory usage backfill as done: ${errorText(err)}`,
      );
    }
  }

  /** One use of each entry, now. Never throws. */
  async count(
    memoryIds: readonly string[],
    field: MemoryUsageField,
  ): Promise<void> {
    if (!this.live || memoryIds.length === 0) {
      return;
    }
    try {
      await this.usage.add(usesOf(memoryIds, field, new Date()));
    } catch (err) {
      this.logger.warn(`memory usage not counted: ${errorText(err)}`);
    }
  }

  private async takeCutoff(): Promise<void> {
    const marker = { cutoff: Date.now(), doneVersion: null };
    try {
      await this.write(marker);
      this.marker = marker;
      this.live = true;
    } catch (err) {
      this.logger.warn(
        `memory usage marker not written; nothing is counted until the next launch: ${errorText(err)}`,
      );
    }
  }

  /** Replaced whole, never left half-written: an unreadable marker stops the backfill for good. */
  private async write(marker: MemoryUsageMarker): Promise<void> {
    const next = `${this.markerPath}.next`;
    await writeFile(next, `${JSON.stringify(marker)}\n`, 'utf8');
    await rename(next, this.markerPath);
  }
}

function parseMarker(text: string): MemoryUsageMarker | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') {
      return null;
    }
    const { cutoff, doneVersion } = value as Record<string, unknown>;
    if (typeof cutoff !== 'number' || !Number.isFinite(cutoff)) {
      return null;
    }
    return {
      cutoff,
      doneVersion: typeof doneVersion === 'number' ? doneVersion : null,
    };
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
