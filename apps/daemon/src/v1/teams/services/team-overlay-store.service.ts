import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import { environment } from '../../../environments';
import { atomicWrite } from '../../../utils/atomic-file';
import { SLUG_RE, type TeamOverlay } from '../teams.types';
import { backUpFile } from '../utils/team-backup';
import { teamFileHash } from '../utils/team-hash';
import { TEAMS_DIR_NAME } from '../utils/team-library-paths';
import {
  parseTeamOverlayYaml,
  serializeTeamOverlayYaml,
  TEAM_OVERLAY_SUFFIX,
  TEAM_OVERLAYS_DIR_NAME,
} from '../utils/team-overlay-yaml';

const BACKUP_DIR = '.backups';
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StoredTeamOverlay {
  overlay: TeamOverlay;
  hash: string;
  source: string;
}

export interface TeamOverlayStoreOptions {
  /** Library directory override (test seam); default `<userData>/teams`. */
  teamsDir?: string;
}

/**
 * The per-project overlays of library teams: one YAML file per (team,
 * project) at `<userData>/teams/overlays/<slug>/<projectId>.overlay.yaml`.
 * Saves are serialized per file and refused `TEAM_OVERLAY_CHANGED` over a
 * newer copy; every replace and delete backs the file up first under
 * `overlays/.backups/<slug>/`.
 */
@Injectable()
export class TeamOverlayStoreService {
  private readonly dir: string;
  private readonly saving = new Map<string, Promise<unknown>>();

  constructor(options: TeamOverlayStoreOptions = {}) {
    this.dir = join(
      options.teamsDir ?? join(environment.userDataDir, TEAMS_DIR_NAME),
      TEAM_OVERLAYS_DIR_NAME,
    );
  }

  /** The overlay file of `(slug, projectId)`, absolute; the slug and id guards every write uses. */
  pathOf(slug: string, projectId: string): string {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'TEAM_SLUG_INVALID',
        `Team slug must match ${SLUG_RE}: ${slug}`,
      );
    }
    if (!PROJECT_ID_RE.test(projectId)) {
      throw new BadRequestException(
        'PROJECT_ID_INVALID',
        `Not a project id: ${projectId}`,
      );
    }
    return join(this.dir, slug, `${projectId}${TEAM_OVERLAY_SUFFIX}`);
  }

  /** The overlay as stored, or null when the project has none. Refuses `TEAM_OVERLAY_UNREADABLE` for a file that does not parse. */
  async get(
    slug: string,
    projectId: string,
  ): Promise<StoredTeamOverlay | null> {
    const source = await this.readSource(this.pathOf(slug, projectId));
    if (source === null) {
      return null;
    }
    return {
      overlay: parseTeamOverlayYaml(source),
      hash: teamFileHash(source),
      source,
    };
  }

  /**
   * Write one overlay. `baseHash` is the version the caller read: a string
   * must still be the file's, null means the caller saw no file, undefined
   * skips the check.
   */
  save(
    slug: string,
    projectId: string,
    overlay: TeamOverlay,
    baseHash?: string | null,
  ): Promise<
    StoredTeamOverlay & { backup: string | null; before: string | null }
  > {
    return this.serialized(slug, projectId, async () => {
      const path = this.pathOf(slug, projectId);
      const existing = await this.readSource(path);
      this.assertBase(slug, existing, baseHash);
      const content = serializeTeamOverlayYaml(overlay);
      const backup =
        existing === null ? null : await this.backUp(slug, projectId, existing);
      await mkdir(join(this.dir, slug), { recursive: true });
      await atomicWrite(path, content);
      return {
        overlay: parseTeamOverlayYaml(content),
        hash: teamFileHash(content),
        source: content,
        backup,
        before: existing,
      };
    });
  }

  /**
   * Put a file back as `source` was, or remove it when `source` is null — a
   * rollback of a write this process just made. With `onlyIfHash`, nothing is
   * touched once the file holds anything but that version; answers whether it
   * was put back.
   */
  restore(
    slug: string,
    projectId: string,
    source: string | null,
    onlyIfHash?: string,
  ): Promise<boolean> {
    return this.serialized(slug, projectId, async () => {
      const path = this.pathOf(slug, projectId);
      if (onlyIfHash !== undefined) {
        const now = await this.readSource(path);
        if (now === null || teamFileHash(now) !== onlyIfHash) {
          return false;
        }
      }
      if (source === null) {
        await rm(path, { force: true });
        return true;
      }
      await mkdir(join(this.dir, slug), { recursive: true });
      await atomicWrite(path, source);
      return true;
    });
  }

  /** Remove one overlay after backing it up; false when there was none. */
  delete(
    slug: string,
    projectId: string,
    baseHash?: string | null,
  ): Promise<boolean> {
    return this.serialized(slug, projectId, async () => {
      const path = this.pathOf(slug, projectId);
      const existing = await this.readSource(path);
      this.assertBase(slug, existing, baseHash);
      if (existing === null) {
        return false;
      }
      await this.backUp(slug, projectId, existing);
      await rm(path, { force: true });
      return true;
    });
  }

  /** The projects holding an overlay of `slug`. */
  async listForTeam(slug: string): Promise<string[]> {
    if (!SLUG_RE.test(slug)) {
      return [];
    }
    const names = await readdir(join(this.dir, slug)).catch(
      () => [] as string[],
    );
    return names
      .filter((name) => name.endsWith(TEAM_OVERLAY_SUFFIX))
      .map((name) => name.slice(0, -TEAM_OVERLAY_SUFFIX.length))
      .filter((id) => PROJECT_ID_RE.test(id))
      .sort();
  }

  /** The teams `projectId` holds an overlay of. */
  async listForProject(projectId: string): Promise<string[]> {
    const held: string[] = [];
    for (const slug of await this.teamDirs()) {
      if ((await this.listForTeam(slug)).includes(projectId)) {
        held.push(slug);
      }
    }
    return held.sort();
  }

  /** Every project holding an overlay of any team. */
  async listProjects(): Promise<string[]> {
    const projects = new Set<string>();
    for (const slug of await this.teamDirs()) {
      for (const projectId of await this.listForTeam(slug)) {
        projects.add(projectId);
      }
    }
    return [...projects].sort();
  }

  /** Remove every overlay of a deleted team, each backed up first; answers the projects that held one. */
  async deleteForTeam(slug: string): Promise<string[]> {
    const projects = await this.listForTeam(slug);
    for (const projectId of projects) {
      await this.delete(slug, projectId);
    }
    return projects;
  }

  /** Remove every overlay a deleted project held, each backed up first. */
  async deleteForProject(projectId: string): Promise<string[]> {
    const slugs = await this.listForProject(projectId);
    for (const slug of slugs) {
      await this.delete(slug, projectId);
    }
    return slugs;
  }

  private async teamDirs(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.filter((name) => name !== BACKUP_DIR && SLUG_RE.test(name));
  }

  private assertBase(
    slug: string,
    existing: string | null,
    baseHash: string | null | undefined,
  ): void {
    if (baseHash === undefined) {
      return;
    }
    const current = existing === null ? null : teamFileHash(existing);
    if (current !== baseHash) {
      throw new ConflictException(
        'TEAM_OVERLAY_CHANGED',
        current === null
          ? `This project's overlay of team '${slug}' was removed since this copy was read`
          : `This project's overlay of team '${slug}' changed since this copy was read — reload it before saving`,
      );
    }
  }

  private async backUp(
    slug: string,
    projectId: string,
    source: string,
  ): Promise<string> {
    const name = await backUpFile(
      join(this.dir, BACKUP_DIR, slug),
      projectId,
      source,
    );
    return `${TEAM_OVERLAYS_DIR_NAME}/${BACKUP_DIR}/${slug}/${name}`;
  }

  private async readSource(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new BadRequestException(
        'TEAM_OVERLAY_UNREADABLE',
        `Cannot read the overlay file: ${(error as Error).message}`,
      );
    }
  }

  private serialized<T>(
    slug: string,
    projectId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${slug}\u0000${projectId}`;
    const previous = this.saving.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.saving.set(key, next);
    void next
      .finally(() => {
        if (this.saving.get(key) === next) {
          this.saving.delete(key);
        }
      })
      .catch(() => undefined);
    return next;
  }
}
