import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import type { AgentReportedCommand } from '../adapters/adapter.types';
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
 * Each entry is a `{name, description}` pair rather than a bare name, because
 * for a CLI with no on-disk convention geniro can scan this report is the ONLY
 * source of the sentence the composer's popup shows beside a row — see
 * {@link AgentReportedCommand}. A cache written by the name-only shape fails
 * {@link isEntry} and is dropped whole on load, which needs no migration: the
 * next turn in that folder re-harvests.
 *
 * Cached to `<userData>/claude-skills.json` (cursor-probe.json precedent) so
 * a daemon restart keeps the enriched list; see {@link HarvestStore} for the
 * shared cache contract.
 */
@Injectable()
export class SkillHarvestStore extends HarvestStore<AgentReportedCommand> {
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

  protected isEntry(value: unknown): value is AgentReportedCommand {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const row = value as Record<string, unknown>;
    return (
      typeof row.name === 'string' &&
      (row.description === null || typeof row.description === 'string')
    );
  }

  /**
   * Record one turn's reported list for its cwd. Names are trimmed, de-duped,
   * and internal (`_`-prefixed) entries dropped; an effectively-empty report
   * is a no-op rather than an eraser of a previous good harvest.
   */
  record(
    agent: AgentKind,
    cwd: string,
    commands: AgentReportedCommand[],
  ): void {
    const cleaned: AgentReportedCommand[] = [];
    const seen = new Set<string>();
    for (const command of commands) {
      const name = command.name.trim();
      if (name === '' || name.startsWith('_') || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const description = command.description?.trim();
      cleaned.push({
        name,
        description:
          description === undefined || description === '' ? null : description,
      });
    }
    this.recordAt(harvestKey(agent, cwd), cleaned);
  }

  /**
   * The last list this agent reported in this cwd, or null when it never has.
   * Keyed by BOTH, because one folder is routinely used by both CLIs and their
   * invokable sets have nothing to do with each other.
   */
  get(agent: AgentKind, cwd: string): AgentReportedCommand[] | null {
    return this.getAt(harvestKey(agent, cwd));
  }
}
