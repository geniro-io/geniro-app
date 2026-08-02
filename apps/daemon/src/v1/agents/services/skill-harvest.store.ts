import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';

/** Defensive bound per (agent, cwd) — init reports ~60 entries today. */
const MAX_HARVESTED = 500;

/**
 * Cache-key separator. NUL terminates a POSIX pathname, so it cannot occur
 * inside one — a composed `<kind>\0<cwd>` key can never collide with a bare
 * cwd, which is what lets a legacy cwd-keyed cache entry be spotted on load.
 * It survives into the persisted JSON as a `\u0000` escape in the key.
 */
const KEY_SEP = '\u0000';

/** Legacy caches predate the agent dimension, and only claude ever wrote one. */
const LEGACY_KEY_AGENT: AgentKind = 'claude';

/** One (agent, cwd) pair's harvested list, as cached on disk. */
interface HarvestRecord {
  commands: string[];
  harvestedAt: number;
}

interface SkillHarvestStoreOptions {
  /** Test seam — the cache file; defaults to `<userData>/claude-skills.json`. */
  file?: string;
}

/**
 * The CLI-reported slash-command lists, harvested from a turn's own session
 * report — claude's `system/init` event and cursor's ACP
 * `available_commands_update` alike — and keyed by the reporting agent AND the
 * turn's canonical cwd. This is the session's authoritative invokable set for
 * that agent; it includes built-ins and plugin skills the disk scan can never
 * see, and the SkillsService merges it over the scan for the composer
 * autocomplete.
 *
 * The agent half of the key is load-bearing: one folder is routinely used by
 * both CLIs, and a command harvested from cursor is not invokable in claude.
 *
 * Cached to `<userData>/claude-skills.json` so a daemon restart keeps the
 * enriched list; the cache is a non-critical nicety, so disk failures degrade
 * to memory-only with a warning, never an error path.
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
   * Record one turn's reported list for its agent and cwd. Names are trimmed,
   * de-duped, and internal (`_`-prefixed) entries dropped; an effectively-empty
   * report is a no-op rather than an eraser of a previous good harvest.
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

  /** The last list harvested from `agent` in `cwd`, or null when never seen. */
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
        for (const [key, value] of Object.entries(parsed)) {
          const record = value as Partial<HarvestRecord> | null;
          if (
            record &&
            Array.isArray(record.commands) &&
            record.commands.every((entry) => typeof entry === 'string') &&
            typeof record.harvestedAt === 'number'
          ) {
            this.records.set(migrateKey(key), {
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

function keyOf(agent: AgentKind, cwd: string): string {
  return `${agent}${KEY_SEP}${cwd}`;
}

/**
 * One-time migration, removable one release after shipping (by then every
 * install has loaded and re-saved its cache in the new format).
 *
 * A cache written before the agent dimension existed is keyed by cwd alone.
 * Only claude ever populated one — the legacy cursor transport reported no
 * commands — so adopting those entries as claude's keeps the enriched list
 * across an upgrade instead of silently dropping it.
 */
function migrateKey(key: string): string {
  return key.includes(KEY_SEP) ? key : keyOf(LEGACY_KEY_AGENT, key);
}
