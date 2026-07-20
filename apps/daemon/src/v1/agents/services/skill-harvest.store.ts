import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';

/** Defensive bound per cwd — init reports ~60 entries today. */
const MAX_HARVESTED = 500;

/** One cwd's harvested list, as cached on disk. */
interface HarvestRecord {
  commands: string[];
  harvestedAt: number;
}

interface SkillHarvestStoreOptions {
  /** Test seam — the cache file; defaults to `<userData>/claude-skills.json`. */
  file?: string;
}

/**
 * The CLI-reported slash-command lists, harvested from claude `system/init`
 * events as turns run (the `slash_commands` AgentEvent) and keyed by the
 * turn's canonical cwd. This is the session's authoritative invokable set —
 * it includes built-ins and plugin skills the disk scan can never see — and
 * the SkillsService merges it over the scan for the composer autocomplete.
 *
 * Cached to `<userData>/claude-skills.json` (cursor-probe.json precedent) so
 * a daemon restart keeps the enriched list; the cache is a non-critical
 * nicety, so disk failures degrade to memory-only with a warning, never an
 * error path.
 */
@Injectable()
export class SkillHarvestStore {
  private readonly logger = new Logger(SkillHarvestStore.name);
  private readonly file: string;
  private records: Map<string, HarvestRecord> | null = null;

  constructor(options: SkillHarvestStoreOptions = {}) {
    this.file =
      options.file ?? join(environment.userDataDir, 'claude-skills.json');
  }

  /**
   * Record one turn's reported list for its cwd. Names are trimmed, de-duped,
   * and internal (`_`-prefixed) entries dropped; an effectively-empty report
   * is a no-op rather than an eraser of a previous good harvest.
   */
  record(cwd: string, commands: string[]): void {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of commands) {
      const name = raw.trim();
      if (name === '' || name.startsWith('_') || seen.has(name)) {
        continue;
      }
      seen.add(name);
      cleaned.push(name);
      if (cleaned.length >= MAX_HARVESTED) {
        break;
      }
    }
    if (cleaned.length === 0) {
      return;
    }
    this.load().set(cwd, { commands: cleaned, harvestedAt: Date.now() });
    this.save();
  }

  /** The last harvested list for a cwd, or null when never harvested. */
  get(cwd: string): string[] | null {
    return this.load().get(cwd)?.commands ?? null;
  }

  private load(): Map<string, HarvestRecord> {
    if (this.records !== null) {
      return this.records;
    }
    this.records = new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [cwd, value] of Object.entries(parsed)) {
          const record = value as Partial<HarvestRecord> | null;
          if (
            record &&
            Array.isArray(record.commands) &&
            record.commands.every((entry) => typeof entry === 'string') &&
            typeof record.harvestedAt === 'number'
          ) {
            this.records.set(cwd, {
              commands: record.commands,
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
        `skill-harvest cache write failed (memory-only until next harvest): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
