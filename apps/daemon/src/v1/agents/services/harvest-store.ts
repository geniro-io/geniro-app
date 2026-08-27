import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';

/** One key's harvested list, as cached on disk. */
interface HarvestRecord<T> {
  entries: T[];
  harvestedAt: number;
}

/**
 * The cache key shared by every harvest: an agent's report says nothing about
 * the other CLI's, so the two are kept apart per folder. NUL-joined because it
 * is the one byte neither an agent kind nor a path can contain — the same key
 * shape the daemon's MCP cache and the renderer's own caches use.
 *
 * Extra dimensions are appended by the subclass that has them — and BOTH
 * subclasses key by the config directory, because it is the account: it decides
 * which MCP servers a folder loads and which plugins the CLI reports commands
 * for. (The skills harvest did not, and served one account's invokable set for
 * every chat in the folder.)
 */
export function harvestKey(agent: AgentKind, ...parts: string[]): string {
  return [agent, ...parts].join('\u0000');
}

/**
 * The disk-backed store behind every "what did the CLI report about this
 * folder" harvest.
 *
 * A harvest exists because a turn ALREADY tells us things that otherwise cost
 * a separate process: claude's `system/init` names the session's invokable
 * slash commands and its MCP servers with their connection status, for free,
 * on every turn. Asking the CLI again with a one-shot subcommand re-derives
 * what a turn just said — and for MCP that means re-dialling every server from
 * cold, which is measured at seconds, not milliseconds.
 *
 * Extracted rather than copied per subject: the cache plumbing (the keyed map,
 * the JSON file, per-record validation on load, the bound, and the
 * degrade-to-memory-on-disk-failure rule) is identical for every harvest, and
 * this codebase has already paid for mirroring it — the M3 review found the
 * same logic in four places. Subclasses supply only what genuinely differs:
 * how a key is built, how a raw report is cleaned, and what a valid entry is.
 *
 * The cache is a non-critical nicety in every case: a missing or malformed
 * file starts empty and the next turn re-harvests, so disk failures warn and
 * carry on rather than becoming an error path.
 */
export abstract class HarvestStore<T> {
  private readonly logger = new Logger(this.constructor.name);
  private records: Map<string, HarvestRecord<T>> | null = null;

  protected constructor(
    private readonly file: string,
    /** Defensive bound per key — a runaway report must not fill the disk. */
    private readonly maxEntries: number,
    /**
     * How long a stored report may be SERVED for. `Infinity` — the default —
     * means a harvest never goes stale on its own, which is right for a subject
     * whose answer does not change behind the daemon's back.
     *
     * A subject that DOES change needs a bound, because a harvest consulted
     * ahead of a live read shadows it: once any turn has run, the read the
     * bound exists to eventually reach is never taken again. That is the
     * difference between a floor and a ceiling.
     */
    private readonly maxAgeMs: number = Infinity,
    /** Clock seam — the harvest ages, so a spec has to be able to move time. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether one value loaded from disk is a valid entry.
   *
   * The per-subclass half of load validation: a record whose entries do not
   * all pass is dropped whole rather than partially trusted, so a cache
   * written by an older shape can never surface as a half-populated answer.
   */
  protected abstract isEntry(value: unknown): value is T;

  /**
   * Store one report under an already-built key.
   *
   * An effectively-empty report is a NO-OP, never an eraser: a turn that
   * reported nothing (or nothing that survived cleaning) says nothing about
   * the folder, and letting it clear a previous good harvest would trade a
   * real answer for silence.
   */
  protected recordAt(key: string, entries: T[]): void {
    if (entries.length === 0) {
      return;
    }
    this.load().set(key, {
      entries: entries.slice(0, this.maxEntries),
      harvestedAt: this.now(),
    });
    this.save();
  }

  /**
   * The last report stored under this key, or null when there is none — or
   * when the one there is has aged past {@link maxAgeMs}.
   *
   * The record is kept rather than deleted on expiry: it is still the best
   * guess available if the live read it makes way for fails, and the next
   * successful harvest overwrites it anyway.
   */
  protected getAt(key: string): T[] | null {
    const record = this.load().get(key);
    if (!record) {
      return null;
    }
    return this.now() - record.harvestedAt < this.maxAgeMs
      ? record.entries
      : null;
  }

  /**
   * The last report stored under this key WHATEVER its age, or null when there
   * has never been one.
   *
   * The age bound exists to stop a harvest SHADOWING a live read — an answer
   * served past it would be one nobody re-checks. Showing the user something
   * while that live read runs is a different act with no such hazard, and it is
   * the case the expiry note on {@link getAt} already describes: the record is
   * kept precisely because it stays the best guess available.
   *
   * Callers must not answer from this. Paint with it, and let the live read
   * settle what is true.
   */
  protected getAnyAt(key: string): T[] | null {
    return this.load().get(key)?.entries ?? null;
  }

  private load(): Map<string, HarvestRecord<T>> {
    if (this.records !== null) {
      return this.records;
    }
    this.records = new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          const record = value as Partial<HarvestRecord<unknown>> | null;
          if (
            record &&
            Array.isArray(record.entries) &&
            record.entries.every((entry) => this.isEntry(entry)) &&
            typeof record.harvestedAt === 'number'
          ) {
            this.records.set(key, {
              entries: record.entries as T[],
              harvestedAt: record.harvestedAt,
            });
          }
        }
      }
    } catch {
      // Missing or malformed cache — start empty; the next turn re-harvests.
    }
    return this.records;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify(Object.fromEntries(this.load())),
        'utf8',
      );
    } catch (err) {
      this.logger.warn(
        `${this.constructor.name} cache write failed (memory-only until next harvest): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
