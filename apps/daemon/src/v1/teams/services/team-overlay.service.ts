import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BaseException, NotFoundException } from '@packages/common';

import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import {
  type ProjectTeamOverlay,
  type Team,
  type TeamOverlay,
  TeamOverlaySchema,
  type TeamOverlayScope,
  type TeamOverlaySnapshot,
  type TeamOverlayWire,
} from '../teams.types';
import {
  firstLineOf,
  restoreOverlayConfigDirs,
} from '../utils/config-dir-redaction';
import type { BuilderOverlayRef } from '../utils/team-chat-instructions';
import {
  applyTeamOverlay,
  overlayCounts,
  overlayDiffText,
  overlayOrphans,
} from '../utils/team-overlay';
import {
  type StoredTeamOverlay,
  TeamOverlayStoreService,
} from './team-overlay-store.service';
import { TeamStoreService } from './team-store.service';

export interface EffectiveTeam {
  team: Team;
  /** The overlay applied; null when the run's project does not default to this team or holds no overlay. */
  overlay: TeamOverlaySnapshot | null;
}

/** An overlay an agent proposed, checked against the team and the file as they stand. */
export type PreparedOverlayChange =
  | {
      ok: true;
      overlay: TeamOverlay;
      current: { overlay: TeamOverlay; hash: string } | null;
      effective: Team;
      diffText: string;
    }
  | {
      ok: false;
      code:
        | 'TEAM_OVERLAY_INVALID'
        | 'TEAM_OVERLAY_UNREADABLE'
        | 'OVERLAY_INACTIVE'
        | 'CONFIG_DIR_UNKNOWN';
      message: string;
    };

export type WrittenOverlay = StoredTeamOverlay & {
  backup: string | null;
  before: string | null;
};

/**
 * The per-project overlays of library teams: which projects a team serves,
 * each project's overlay as the team page edits it, and the effective team a
 * run of the project's DEFAULT team runs on. An overlay of a team the project
 * no longer defaults to stays on disk, inactive.
 */
@Injectable()
export class TeamOverlayService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TeamOverlayService.name);
  private subscription: { unsubscribe(): void } | null = null;

  constructor(
    private readonly overlays: TeamOverlayStoreService,
    private readonly store: TeamStoreService,
    private readonly projects: ProjectDao,
    private readonly em: EntityManager,
    private readonly projectEvents?: ProjectEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription =
      this.projectEvents?.allChanges().subscribe(({ projectId }) => {
        void this.dropIfProjectGone(projectId);
      }) ?? null;
  }

  /** A project deleted while the daemon was down leaves overlays of nothing — swept once per boot, off the ready path. */
  onApplicationBootstrap(): void {
    void this.sweepOrphans();
  }

  /** Remove the overlays of every project that no longer exists. */
  async sweepOrphans(): Promise<string[]> {
    let projects: string[];
    try {
      projects = await this.overlays.listProjects();
    } catch (error) {
      this.logger.warn(`orphaned overlays not swept: ${messageOf(error)}`);
      return [];
    }
    const swept: string[] = [];
    for (const projectId of projects) {
      if ((await this.dropIfProjectGone(projectId)).length > 0) {
        swept.push(projectId);
      }
    }
    return swept;
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** The overlay as stored, or null; refuses `TEAM_OVERLAY_UNREADABLE` for a file that does not parse. */
  async storedOverlay(
    slug: string,
    projectId: string,
  ): Promise<{ overlay: TeamOverlay; hash: string } | null> {
    const stored = await this.overlays.get(slug, projectId);
    return stored === null
      ? null
      : { overlay: stored.overlay, hash: stored.hash };
  }

  /**
   * Why a run of `slug` in `projectId` would be refused for the project's
   * overlay (`TEAM_OVERLAY_UNREADABLE` / `TEAM_OVERLAY_INVALID`), or null when
   * it would start.
   */
  async refusalOf(slug: string, projectId: string): Promise<string | null> {
    try {
      await this.effectiveBySlug(slug, projectId);
      return null;
    } catch (error) {
      if (
        error instanceof BaseException &&
        error.errorCode.startsWith('TEAM_OVERLAY_')
      ) {
        return error.message;
      }
      throw error;
    }
  }

  /** Whether `projectId`'s default team is `slug` — the only case its overlay applies. */
  async isDefaultTeam(slug: string, projectId: string): Promise<boolean> {
    const project = await this.projects.getById(projectId, this.em.fork());
    return project !== null && project.teamSlug === slug;
  }

  async projectName(projectId: string): Promise<string> {
    return (await this.requireProject(projectId)).name;
  }

  /**
   * Parse an overlay an agent sent for `projectId`'s copy of `slug`, refuse
   * one the project's runs would not use or the team cannot take, and diff it
   * against the file as it stands. With `tokens`, a `read_teams` token in a
   * `configDir` is put back to the profile it names.
   */
  async prepareChange(
    slug: string,
    team: Team,
    projectId: string,
    proposed: unknown,
    options: { tokens?: boolean } = {},
  ): Promise<PreparedOverlayChange> {
    const parsed = TeamOverlaySchema.safeParse(proposed);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'TEAM_OVERLAY_INVALID',
        message: parsed.error.issues
          .slice(0, 5)
          .map((issue) => `overlay.${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      };
    }
    if (!(await this.isDefaultTeam(slug, projectId))) {
      return {
        ok: false,
        code: 'OVERLAY_INACTIVE',
        message: `the project does not default to team '${slug}', so its runs would not use this overlay`,
      };
    }
    let current: { overlay: TeamOverlay; hash: string } | null;
    try {
      current = await this.storedOverlay(slug, projectId);
    } catch (error) {
      return {
        ok: false,
        code: 'TEAM_OVERLAY_UNREADABLE',
        message: firstLineOf(messageOf(error)),
      };
    }
    let next: TeamOverlay = parsed.data;
    if (options.tokens) {
      const restored = restoreOverlayConfigDirs(next, team, [
        team,
        ...storedProfiles(team, current?.overlay, projectId),
      ]);
      if (!restored.ok) {
        return {
          ok: false,
          code: 'CONFIG_DIR_UNKNOWN',
          message: restored.message,
        };
      }
      next = restored.overlay;
    }
    let effective: Team;
    try {
      effective = applyTeamOverlay(team, next, projectId).team;
    } catch (error) {
      return {
        ok: false,
        code: 'TEAM_OVERLAY_INVALID',
        message: messageOf(error),
      };
    }
    return {
      ok: true,
      overlay: next,
      current,
      effective,
      diffText: overlayDiffText(projectId, current?.overlay ?? {}, next),
    };
  }

  /** One overlay write, hash-guarded and backed up. */
  writeOverlay(
    slug: string,
    projectId: string,
    overlay: TeamOverlay,
    baseHash: string | null,
  ): Promise<WrittenOverlay> {
    return this.overlays.save(slug, projectId, overlay, baseHash);
  }

  /**
   * The overlay first, then the team through `writeTeam`; a team write that
   * fails puts the overlay back as it was, so the pair is never half written.
   */
  async writeWithTeam<T>(
    slug: string,
    projectId: string,
    overlay: TeamOverlay,
    baseHash: string | null,
    writeTeam: () => Promise<T>,
  ): Promise<{ overlay: WrittenOverlay; team: T }> {
    const written = await this.overlays.save(
      slug,
      projectId,
      overlay,
      baseHash,
    );
    try {
      return { overlay: written, team: await writeTeam() };
    } catch (error) {
      try {
        const restored = await this.overlays.restore(
          slug,
          projectId,
          written.before,
          written.hash,
        );
        if (!restored) {
          this.logger.warn(
            `the overlay of ${slug} for project ${projectId} was not put back after the team write failed: it changed meanwhile`,
          );
        }
      } catch (restoreError) {
        this.logger.warn(
          `the overlay of ${slug} for project ${projectId} could not be put back after the team write failed: ${messageOf(restoreError)}`,
        );
      }
      throw error;
    }
  }

  /** A deleted team's overlays go with it, each backed up first; answers the projects that held one. */
  deleteForTeam(slug: string): Promise<string[]> {
    return this.overlays.deleteForTeam(slug);
  }

  /**
   * What a builder chat on `slug` is told about overlays: the one it edits
   * when bound to `projectId`, and every other one read-only.
   */
  async builderRefs(
    slug: string,
    projectId: string | null,
  ): Promise<{
    overlay?: BuilderOverlayRef;
    otherOverlays: BuilderOverlayRef[];
  }> {
    const scopes = await this.scopes(slug);
    const refs = scopes.map((scope): BuilderOverlayRef => ({
      projectId: scope.projectId,
      projectName: scope.projectName,
      path: this.overlays.pathOf(slug, scope.projectId),
      active: scope.active,
    }));
    const bound =
      projectId === null
        ? undefined
        : refs.find((ref) => ref.projectId === projectId);
    return {
      ...(bound ? { overlay: bound } : {}),
      otherOverlays: refs.filter(
        (ref) =>
          ref !== bound &&
          scopes.find((s) => s.projectId === ref.projectId)?.hasOverlay,
      ),
    };
  }

  /** Where `projectId`'s overlay of `slug` is kept, whether or not it exists yet. */
  overlayPathOf(slug: string, projectId: string): string {
    return this.overlays.pathOf(slug, projectId);
  }

  /** A deleted project's overlays go with it, each backed up first. */
  async dropIfProjectGone(projectId: string): Promise<string[]> {
    try {
      const held = await this.overlays.listForProject(projectId);
      if (
        held.length === 0 ||
        (await this.projects.getById(projectId, this.em.fork())) !== null
      ) {
        return [];
      }
      return await this.overlays.deleteForProject(projectId);
    } catch (error) {
      this.logger.warn(
        `the overlays of deleted project ${projectId} were not removed: ${messageOf(error)}`,
      );
      return [];
    }
  }

  /**
   * The team a run of `slug` in `projectId` runs on. Only a project whose
   * default team is `slug` applies its overlay; a missing overlay is the
   * shared team, an unreadable or invalid one refuses
   * (`TEAM_OVERLAY_UNREADABLE` / `TEAM_OVERLAY_INVALID`).
   */
  async effective(
    slug: string,
    team: Team,
    projectId: string | null,
  ): Promise<EffectiveTeam> {
    if (projectId === null) {
      return { team, overlay: null };
    }
    if (!(await this.isDefaultTeam(slug, projectId))) {
      return { team, overlay: null };
    }
    const stored = await this.overlays.get(slug, projectId);
    if (stored === null) {
      return { team, overlay: null };
    }
    return {
      team: applyTeamOverlay(team, stored.overlay, projectId).team,
      overlay: { projectId, hash: stored.hash, overlay: stored.overlay },
    };
  }

  /** {@link effective} for the library's current copy of `slug`. */
  async effectiveBySlug(
    slug: string,
    projectId: string | null,
  ): Promise<EffectiveTeam> {
    const { team } = await this.store.get(slug);
    return this.effective(slug, team, projectId);
  }

  async get(slug: string, projectId: string): Promise<TeamOverlayWire> {
    const [{ team }] = await Promise.all([
      this.store.get(slug),
      this.requireProject(projectId),
    ]);
    const stored = await this.overlays.get(slug, projectId);
    const overlay = stored?.overlay ?? {};
    return {
      slug,
      projectId,
      overlay,
      hash: stored?.hash ?? null,
      orphans: overlayOrphans(team, overlay),
    };
  }

  /** Write a project's overlay of `slug`, refused when it would not run (`TEAM_OVERLAY_INVALID`). */
  async save(
    slug: string,
    projectId: string,
    overlay: TeamOverlay,
    baseHash: string | null | undefined,
  ): Promise<TeamOverlayWire> {
    const [{ team }] = await Promise.all([
      this.store.get(slug),
      this.requireProject(projectId),
    ]);
    applyTeamOverlay(team, overlay, projectId);
    const saved = await this.overlays.save(slug, projectId, overlay, baseHash);
    return {
      slug,
      projectId,
      overlay: saved.overlay,
      hash: saved.hash,
      orphans: overlayOrphans(team, saved.overlay),
    };
  }

  async remove(
    slug: string,
    projectId: string,
    baseHash?: string | null,
  ): Promise<{ deleted: boolean }> {
    return { deleted: await this.overlays.delete(slug, projectId, baseHash) };
  }

  /**
   * The projects in `slug`'s scope list: every project whose default team it
   * is, then every project still holding an overlay of it while defaulting to
   * something else (inactive).
   */
  async scopes(slug: string): Promise<TeamOverlayScope[]> {
    const [{ team }, projects, held, names] = await Promise.all([
      this.store.get(slug),
      this.projects.listAll(this.em.fork()),
      this.overlays.listForTeam(slug),
      this.teamNames(),
    ]);
    const heldSet = new Set(held);
    const listed = projects.filter(
      (project) => project.teamSlug === slug || heldSet.has(project.id),
    );
    const scopes = await Promise.all(
      listed.map((project) =>
        this.scopeOf(slug, team, project, heldSet, names),
      ),
    );
    return scopes.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        a.projectName.localeCompare(b.projectName),
    );
  }

  /**
   * Every team's overlay `projectId` holds, its default team's first: the
   * others are inactive until the project defaults to their team again.
   */
  async forProject(projectId: string): Promise<ProjectTeamOverlay[]> {
    const project = await this.requireProject(projectId);
    const [held, names] = await Promise.all([
      this.overlays.listForProject(projectId),
      this.teamNames(),
    ]);
    const overlays: ProjectTeamOverlay[] = [];
    for (const slug of held) {
      const name = names.get(slug);
      if (name === undefined) {
        continue;
      }
      const { team } = await this.store.get(slug);
      const scope = await this.scopeOf(
        slug,
        team,
        project,
        new Set([projectId]),
        names,
      );
      overlays.push({ ...scope, slug, teamName: name });
    }
    return overlays.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        a.teamName.localeCompare(b.teamName),
    );
  }

  private async scopeOf(
    slug: string,
    team: Team,
    project: Project,
    held: ReadonlySet<string>,
    names: ReadonlyMap<string, string>,
  ): Promise<TeamOverlayScope> {
    const base = {
      projectId: project.id,
      projectName: project.name,
      active: project.teamSlug === slug,
      defaultTeamSlug: project.teamSlug,
      defaultTeamName:
        project.teamSlug === null
          ? null
          : (names.get(project.teamSlug) ?? null),
    };
    if (!held.has(project.id)) {
      return {
        ...base,
        hasOverlay: false,
        hash: null,
        overrides: 0,
        blocks: 0,
        notes: 0,
        orphans: [],
        unreadable: null,
      };
    }
    try {
      const stored = await this.overlays.get(slug, project.id);
      const overlay = stored?.overlay ?? {};
      return {
        ...base,
        hasOverlay: stored !== null,
        hash: stored?.hash ?? null,
        ...overlayCounts(overlay),
        orphans: overlayOrphans(team, overlay),
        unreadable: null,
      };
    } catch (error) {
      return {
        ...base,
        hasOverlay: true,
        hash: null,
        overrides: 0,
        blocks: 0,
        notes: 0,
        orphans: [],
        unreadable: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async teamNames(): Promise<Map<string, string>> {
    const teams = await this.store.list();
    return new Map(teams.map((team) => [team.slug, team.name]));
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.getById(projectId, this.em.fork());
    if (project === null) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `No project '${projectId}'`,
      );
    }
    return project;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storedProfiles(
  team: Team,
  stored: TeamOverlay | undefined,
  projectId: string,
): Team[] {
  if (stored === undefined) {
    return [];
  }
  try {
    return [applyTeamOverlay(team, stored, projectId).team];
  } catch {
    return [];
  }
}
