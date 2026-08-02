import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';

/** Defensive bound per key — init reports ~60 entries today. */
const MAX_HARVESTED = 500;

/** One (agent, cwd) pair's harvested list, as cached on disk. */
interface HarvestRecord {
  commands: string[];
  harvestedAt: number;
}

/**
 * The cache key: an agent's report says nothing about the other CLI's, so the
 * two are kept apart per folder. NUL-joined because it is the one byte a path
 * cannot contain — the same key shape the renderer's own skills cache uses.
 */
function keyOf(agent: AgentKind, cwd: string): string {
  return `${agent}\u0000${cwd}`;
}

interface SkillHarvestStoreOptions {
  /** Test seam — the cache file; defaults to `<userData>/claude-skills.json`. */
  file?: string;
}

/**
 * The CLI-reported slash-command lists, harvested from the `slash_commands`
 * AgentEvent as turns run and keyed by the reporting agent plus the turn's
 * canonical cwd.
 *
 * This is a session's authoritative invokable set for one folder — it includes
 * the built-ins, plugin skills, and anything project-scoped that neither the
 * disk scan nor a generic probe can see — so `SkillsService` ranks it ahead of
 * the adapter's own catalog when composing the composer autocomplete.
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
  record(agent: AgentKind, cwd: string, commands: string[]): void {
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
    this.load().set(keyOf(agent, cwd), {
      commands: cleaned,
      harvestedAt: Date.now(),
    });
    this.save();
  }

  /**
   * The last list this agent reported in this cwd, or null when it never has.
   * Keyed by BOTH, because one folder is routinely used by both CLIs and their
   * invokable sets have nothing to do with each other.
   */
  get(agent: AgentKind, cwd: string): string[] | null {
    return this.load().get(keyOf(agent, cwd))?.commands ?? null;
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
