import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentSkillEntry } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentSkillWire } from '../chat.types';
import { resolveAgentVersion } from '../utils/agent-version';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { ProcessRegistry } from './process-registry';
import { SkillHarvestStore } from './skill-harvest.store';

/** Hard cap on the reply — this feeds a composer popup, not an inventory API. */
const MAX_SKILLS = 200;

/**
 * Re-ask the CLI for its own commands no more than this often. The set only
 * moves when the CLI, its plugins, or the account change, and asking costs a
 * (cancelled) turn.
 */
const DEFAULT_CATALOG_TTL_MS = 30 * 60_000;

/** Constructor options — test seams, not user config. */
export interface SkillsServiceOptions {
  /** The "user" scan root; defaults to the real home dir. */
  homeDir?: string;
  /** How long a cached command catalog stays fresh. */
  catalogTtlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: typeof resolveAgentVersion;
}

/** Popup ordering: the user's own entries first, CLI-reported extras last. */
const SOURCE_RANK: Record<AgentSkillWire['source'], number> = {
  project: 0,
  user: 1,
  cli: 2,
};

interface CatalogEntry {
  version: string | null;
  fetchedAt: number;
  commands: string[];
}

/**
 * The composer's `/` autocomplete: what a CLI agent can be invoked with in a
 * given folder.
 *
 * Every CLI-specific detail lives in that CLI's adapter — where its skills and
 * commands sit on disk (`listSkills`) and what it reports about itself
 * (`listReportedCommands`). This service only composes the three sources and
 * decides WHEN to ask:
 *
 * - **The adapter's disk scan** — the only source of descriptions, and the
 *   only one that sees a brand-new file the moment it is written.
 * - **This cwd's harvest** — the `slash_commands` the CLI reported on a turn
 *   that actually ran here ({@link SkillHarvestStore}), so it is authoritative
 *   for THIS folder, including anything project-scoped.
 * - **The adapter's command catalog** — the same report asked of the binary up
 *   front, cached per `<binary> --version` on top of a TTL (the ModelsService
 *   key). It is the floor that makes a folder no turn has ever run in list the
 *   built-ins instead of nothing at all.
 *
 * Names collide across all three: first occurrence wins, so a scanned entry
 * keeps its description and its kind over a bare reported name.
 */
@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);
  private readonly homeDir: string;
  private readonly catalogTtlMs: number;
  private readonly now: () => number;
  private readonly resolveVersionFn: typeof resolveAgentVersion;
  private readonly catalog = new Map<AgentKind, CatalogEntry>();
  private readonly inFlight = new Map<AgentKind, Promise<string[]>>();

  constructor(
    private readonly harvest: SkillHarvestStore,
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    options: SkillsServiceOptions = {},
  ) {
    this.homeDir = options.homeDir ?? homedir();
    this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
    this.resolveVersionFn = options.resolveVersionFn ?? resolveAgentVersion;
  }

  async list(agent: AgentKind, cwd: string): Promise<AgentSkillWire[]> {
    const projectDir = resolveValidCwd(cwd);
    const adapter = this.adapterFor(agent);
    const scanned = await adapter.listSkills({
      cwd: projectDir,
      homeDir: this.homeDir,
    });
    const byName = new Map<string, AgentSkillEntry>();
    for (const skill of scanned) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
    // This cwd's own harvest leads the catalog, being the authoritative report
    // for THIS folder; the catalog is the cwd-independent floor beneath it.
    const reported = [
      ...(this.harvest.get(agent, projectDir) ?? []),
      ...(await this.reportedCommands(agent)),
    ];
    for (const name of reported) {
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          description: null,
          kind: 'command',
          source: 'cli',
        });
      }
    }
    return [...byName.values()]
      .sort(
        (a, b) =>
          SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_SKILLS);
  }

  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * The CLI's self-reported commands, asked at most once per version+TTL and
   * never twice concurrently. An adapter that cannot answer yields `[]`, and
   * that miss is cached like any other answer — a broken install must not
   * re-probe on every autocomplete read.
   */
  private async reportedCommands(kind: AgentKind): Promise<string[]> {
    const pending = this.inFlight.get(kind);
    if (pending) {
      return pending;
    }
    const version = await this.resolveVersionFn(kind, {
      onSpawn: (child) =>
        this.processes.register(
          `skills:version:${randomUUID()}`,
          childProcessHandle(child, { processGroup: false }),
        ),
    });
    const cached = this.catalog.get(kind);
    if (
      cached &&
      cached.version === version &&
      this.now() - cached.fetchedAt < this.catalogTtlMs
    ) {
      return cached.commands;
    }
    const ask = this.adapterFor(kind)
      .listReportedCommands({
        onTurn: (handle) =>
          this.processes.register(`skills:commands:${randomUUID()}`, handle),
      })
      .catch((err: unknown) => {
        // An adapter must not throw here, but the autocomplete is a nicety —
        // degrade to the disk scan rather than fail the request.
        this.logger.warn(
          `listing ${kind} commands failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as string[];
      })
      .then((commands) => {
        this.catalog.set(kind, {
          version,
          fetchedAt: this.now(),
          commands,
        });
        return commands;
      })
      .finally(() => this.inFlight.delete(kind));
    this.inFlight.set(kind, ask);
    return ask;
  }
}
