import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentReportedCommand,
  AgentSkillEntry,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentSkillWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
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
  resolveVersionFn?: AgentVersionService['resolve'];
}

/**
 * Popup ordering: this app's own commands, then the user's own entries, then
 * CLI-reported extras.
 *
 * `geniro` leads because those names are RESERVED — `ChatService` dispatches
 * them by name whatever else a folder happens to hold — so a scanned skill
 * sharing one would be a row the popup offers and the send never runs.
 */
const SOURCE_RANK: Record<AgentSkillWire['source'], number> = {
  geniro: 0,
  project: 1,
  user: 2,
  cli: 3,
};

interface CatalogEntry {
  version: string | null;
  fetchedAt: number;
  commands: AgentReportedCommand[];
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
  private readonly resolveVersionFn: AgentVersionService['resolve'];
  private readonly catalog = new Map<AgentKind, CatalogEntry>();
  private readonly inFlight = new Map<
    AgentKind,
    Promise<AgentReportedCommand[]>
  >();

  constructor(
    private readonly harvest: SkillHarvestStore,
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    options: SkillsServiceOptions = {},
  ) {
    this.homeDir = options.homeDir ?? homedir();
    this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
    this.resolveVersionFn =
      options.resolveVersionFn ??
      ((kind, opts) => versions.resolve(kind, opts));
  }

  async list(agent: AgentKind, cwd: string): Promise<AgentSkillWire[]> {
    const projectDir = resolveValidCwd(cwd);
    const adapter = this.adapterFor(agent);
    const scanned = await adapter.listSkills({
      cwd: projectDir,
      homeDir: this.homeDir,
    });
    const byName = new Map<string, AgentSkillEntry>();
    // FIRST, ahead of the disk scan, because these names are reserved rather
    // than merely ranked: `ChatService` looks a send up against the same
    // adapter list, so a project skill called `compact` that won the row would
    // be offered by the popup and never be what ran.
    for (const command of adapter.listGeniroCommands()) {
      byName.set(command.name, {
        name: command.name,
        description: command.description,
        kind: 'command',
        source: 'geniro',
      });
    }
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
    for (const command of reported) {
      const known = byName.get(command.name);
      if (known === undefined) {
        byName.set(command.name, {
          name: command.name,
          description: command.description,
          kind: 'command',
          source: 'cli',
        });
        continue;
      }
      // First occurrence still wins the ENTRY — a scanned row keeps its `kind`
      // and its `source`, so the popup's badge stays true. What a later source
      // may still contribute is a DESCRIPTION the winner does not have: a
      // command file with no frontmatter scans to a bare name, while the CLI's
      // own report says what it does, and preferring silence there would throw
      // away the only sentence anyone has.
      if (known.description === null && command.description !== null) {
        byName.set(command.name, {
          ...known,
          description: command.description,
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
  private async reportedCommands(
    kind: AgentKind,
  ): Promise<AgentReportedCommand[]> {
    const pending = this.inFlight.get(kind);
    if (pending) {
      return pending;
    }
    const version = await this.resolveVersionFn(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `skills:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
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
        return [] as AgentReportedCommand[];
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
