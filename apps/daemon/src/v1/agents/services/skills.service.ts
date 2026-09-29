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
 * `(agent, profile)` — the catalog's key.
 *
 * The PROFILE is in it because a profile carries its own installed plugins, and
 * their commands are half of what this catalog holds: keyed by agent alone, the
 * first chat to ask filed ITS profile's list and every other profile was
 * offered that one. `vocabularyProfile` folds it back to null for a CLI whose
 * account is not a directory, so cursor keeps one entry. NUL-joined as an
 * escape, on `ModelsService`'s own key's rule.
 */
function catalogKey(kind: AgentKind, profile: string | null): string {
  return `${kind}\u0000${profile ?? ''}`;
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
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<AgentReportedCommand[]>
  >();
  /**
   * Bumped per agent by {@link forgetAgent}: an ask that STARTED before the
   * account changed must not file its answer after — it was taken under the
   * credentials the user just replaced.
   */
  private readonly generations = new Map<AgentKind, number>();

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

  async list(
    agent: AgentKind,
    cwd: string,
    configDir: string | null = null,
  ): Promise<AgentSkillWire[]> {
    const projectDir = resolveValidCwd(cwd);
    const adapter = this.adapterFor(agent);
    // The run's own PROFILE, which is where that account's skills, commands and
    // installed plugins live — the scan took the home dir for every chat, so a
    // chat on a profile was offered the default account's list and none of its
    // own. See `AgentAdapter.listSkills`.
    const scanned = await adapter.listSkills({
      cwd: projectDir,
      homeDir: this.homeDir,
      configDir,
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
      ...(this.harvest.get(agent, projectDir, configDir) ?? []),
      ...(await this.reportedCommands(agent, configDir)),
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
    // Every entry, uncapped. The list is not only the popup's rows: the composer
    // refuses to send a command that is not in it (`unknownSlashCommand`), so a
    // cap is a list of commands the user cannot run. REPORTED as `/geniro:resolve`
    // missing from the popup in a folder whose project and profile hold 150
    // skills of their own — the 200-row cap, applied after a sort that files the
    // CLI's report last, was dropping 28 of claude's own commands (`/model`,
    // `/init`, `/mcp`, …) there, and a plugin's names are in that same report.
    // The popup filters and scrolls; a few hundred rows is nothing to send.
    return [...byName.values()].sort(
      (a, b) =>
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        a.name.localeCompare(b.name),
    );
  }

  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * Forget every cached command catalog, and say how many went — the user
   * pressed "Clear Agent Cache" (`CacheResetService.clearAll`).
   *
   * An ask already running is left to finish and file its answer, on
   * `ModelVocabularyCache.clear`'s reasoning: it is a FRESH ask, which is
   * exactly what the reset wants.
   */
  clearCache(): number {
    const dropped = this.catalog.size;
    this.catalog.clear();
    return dropped;
  }

  /**
   * Forget what ONE agent's CLI reported about itself, because it is now a
   * different account (`CacheResetService.forgetAgent`).
   *
   * Stricter than {@link clearCache}: an ask already running was taken under
   * the credentials just replaced, so it is detached — a caller arriving now
   * starts a fresh one instead of joining it — and its answer is discarded
   * when it lands rather than filed.
   */
  forgetAgent(kind: AgentKind): number {
    const prefix = catalogKey(kind, null);
    let dropped = 0;
    for (const key of [...this.catalog.keys()]) {
      if (key.startsWith(prefix)) {
        this.catalog.delete(key);
        dropped += 1;
      }
    }
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    this.generations.set(kind, (this.generations.get(kind) ?? 0) + 1);
    return dropped;
  }

  /**
   * The CLI's self-reported commands for one PROFILE, asked at most once per
   * version+TTL and never twice concurrently. An adapter that cannot answer
   * yields `[]`, and that miss is cached like any other answer — a broken
   * install must not re-probe on every autocomplete read.
   *
   * The single-flight covers the WHOLE read, the `--version` resolution
   * included. It was registered only after that await, so two composers opening
   * at once both found the map empty, both resolved the version, and both
   * spawned a probe turn — and the first to finish then deleted the SECOND's
   * entry on its way out, so a third caller spawned a third.
   */
  private reportedCommands(
    kind: AgentKind,
    configDir: string | null,
  ): Promise<AgentReportedCommand[]> {
    const profile = this.adapterFor(kind).vocabularyProfile(configDir);
    const key = catalogKey(kind, profile);
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const ask = this.readCatalog(kind, profile, key);
    this.inFlight.set(key, ask);
    void ask.finally(() => {
      // Only its OWN entry: a `forgetAgent` may have replaced it with a newer
      // ask by the time this one lands.
      if (this.inFlight.get(key) === ask) {
        this.inFlight.delete(key);
      }
    });
    return ask;
  }

  /** The catalog read itself — never rejects, see {@link reportedCommands}. */
  private async readCatalog(
    kind: AgentKind,
    profile: string | null,
    key: string,
  ): Promise<AgentReportedCommand[]> {
    const generation = this.generations.get(kind) ?? 0;
    try {
      const version = await this.resolveVersionFn(kind, {
        onSpawn: (child, spawnInfo) =>
          this.processes.register(
            `skills:version:${randomUUID()}`,
            childProcessHandle(child, spawnInfo),
          ),
      });
      const cached = this.catalog.get(key);
      if (
        cached &&
        cached.version === version &&
        this.now() - cached.fetchedAt < this.catalogTtlMs
      ) {
        return cached.commands;
      }
      const commands = await this.adapterFor(kind).listReportedCommands({
        // The PROFILE's own probe: its plugins are its own.
        configDir: profile,
        onTurn: (handle) =>
          this.processes.register(`skills:commands:${randomUUID()}`, handle),
      });
      if ((this.generations.get(kind) ?? 0) === generation) {
        this.catalog.set(key, {
          version,
          fetchedAt: this.now(),
          commands,
        });
      }
      return commands;
    } catch (err) {
      // An adapter must not throw here, but the autocomplete is a nicety —
      // degrade to the disk scan rather than fail the request.
      this.logger.warn(
        `listing ${kind} commands failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
