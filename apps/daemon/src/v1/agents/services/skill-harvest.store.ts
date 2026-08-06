import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import { harvestKey, HarvestStore } from './harvest-store';

/** Defensive bound per key — init reports ~60 entries today. */
const MAX_HARVESTED = 500;

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
 * a daemon restart keeps the enriched list; see {@link HarvestStore} for the
 * shared cache contract.
 */
@Injectable()
export class SkillHarvestStore extends HarvestStore<string> {
  constructor(options: { file?: string } = {}) {
    // No max age, deliberately — unlike the MCP harvest, this one is MERGED
    // with the other sources rather than consulted instead of them, so it
    // shadows nothing that would otherwise be re-read. A command the CLI
    // reported once stays a real command until a later turn says otherwise.
    super(
      options.file ?? join(environment.userDataDir, 'claude-skills.json'),
      MAX_HARVESTED,
    );
  }

  protected isEntry(value: unknown): value is string {
    return typeof value === 'string';
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
    }
    this.recordAt(harvestKey(agent, cwd), cleaned);
  }

  /**
   * The last list this agent reported in this cwd, or null when it never has.
   * Keyed by BOTH, because one folder is routinely used by both CLIs and their
   * invokable sets have nothing to do with each other.
   */
  get(agent: AgentKind, cwd: string): string[] | null {
    return this.getAt(harvestKey(agent, cwd));
  }
}
