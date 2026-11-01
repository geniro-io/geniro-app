import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  InternalException,
  NotFoundException,
} from '@packages/common';
import { parseDocument } from 'yaml';

import { environment } from '../../../environments';
import { atomicCreate, atomicWrite } from '../../../utils/atomic-file';
import type { AgentKind } from '../../runs/runs.types';
import {
  SLUG_RE,
  type Team,
  TEAM_AGENT_KINDS,
  type TeamLocation,
  type TeamSummary,
  type TeamWire,
  TeamYamlSchema,
} from '../teams.types';
import { teamFileHash } from '../utils/team-hash';
import {
  TEAM_SCHEMA_FILE_NAME,
  teamJsonSchema,
} from '../utils/team-json-schema';
import { isReservedTeamSlug, slugifyTeamName } from '../utils/team-slug';
import { assertValidTeam } from '../utils/team-validate';
import {
  parseTeamYaml,
  parseTeamYamlDocument,
  serializeTeamYaml,
} from '../utils/team-yaml';

/** `<userData>/` directory the team library lives in. */
export const TEAMS_DIR_NAME = 'teams';

/** Library file suffix — a team `foo` lives at `<dir>/foo.team.yaml`. */
export const TEAM_SUFFIX = '.team.yaml';

/** What a library file was named before the rename; an import of one still takes its slug from the name. */
export const LEGACY_TEAM_SUFFIX = '.geniro.yaml';

/**
 * Tally a team's members by agent kind for the library summary. Only kinds
 * actually present appear, ordered by `TEAM_AGENT_KINDS` so the card badges
 * render in a stable order regardless of member order.
 */
function agentCountsOf(team: Team): { kind: AgentKind; count: number }[] {
  const counts = new Map<AgentKind, number>();
  for (const member of team.members) {
    counts.set(member.agent, (counts.get(member.agent) ?? 0) + 1);
  }
  return TEAM_AGENT_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  });
}

export interface TeamStoreOptions {
  /** Library directory override (test seam); default `<userData>/teams`. */
  teamsDir?: string;
}

/**
 * The central team library: `*.team.yaml` files under the userData dir.
 * YAML is the source of truth (never SQLite); saves go through the
 * comment-preserving serializer and are validated (zod shape + the team
 * rules) before touching disk. Writes are atomic
 * (tmp + rename) so a crash never leaves a half-written team.
 */
@Injectable()
export class TeamStoreService {
  private readonly logger = new Logger(TeamStoreService.name);
  private readonly dir: string;

  /** The save in flight per slug — see {@link save}. */
  private readonly saving = new Map<string, Promise<TeamWire>>();

  constructor(options: TeamStoreOptions = {}) {
    this.dir =
      options.teamsDir ?? join(environment.userDataDir, TEAMS_DIR_NAME);
  }

  private fileFor(slug: string): string {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'TEAM_SLUG_INVALID',
        `Team slug must match ${SLUG_RE}: ${slug}`,
      );
    }
    return join(this.dir, `${slug}${TEAM_SUFFIX}`);
  }

  /**
   * Where one team's file sits on disk — the library directory and the
   * file itself.
   *
   * The public face of {@link fileFor}, so a caller that has to NAME the file
   * (the builder's chat panel, which hands an agent the directory as its cwd
   * and the path as the thing it edits) gets the same slug guard every write
   * here goes through, rather than joining a path of its own.
   *
   * Pure path arithmetic: it neither creates the directory nor checks that the
   * file is there, because every caller is already holding the team it
   * read through {@link get}.
   */
  locate(slug: string): TeamLocation {
    return { directory: this.dir, path: this.fileFor(slug) };
  }

  /**
   * Write the library's JSON Schema (`teamJsonSchema`) beside the
   * teams and answer its path — the structure reference an editing agent
   * is pointed at.
   *
   * Rewritten on every call rather than once, so the file on disk always
   * describes the schema of the daemon that is running: an app update that
   * adds a field reaches the next chat that opens, with no version to track.
   */
  async writeSchemaReference(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, TEAM_SCHEMA_FILE_NAME);
    await atomicWrite(path, teamJsonSchema());
    return path;
  }

  /** Validate beyond the zod shape: members, trigger, ids and stages. */
  async list(): Promise<TeamSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir);
    // Read + stat every file concurrently — a large library listed
    // sequentially pays one disk round-trip pair per team.
    const summaries = (
      await Promise.all(
        entries
          .filter((e) => e.endsWith(TEAM_SUFFIX))
          .map(async (entry): Promise<TeamSummary | null> => {
            const path = join(this.dir, entry);
            try {
              const team = parseTeamYaml(await readFile(path, 'utf8'));
              const stats = await stat(path);
              return {
                slug: entry.slice(0, -TEAM_SUFFIX.length),
                name: team.name,
                description: team.description ?? null,
                memberCount: team.members.length,
                stageCount: team.stages?.length ?? 0,
                agentCounts: agentCountsOf(team),
                updatedAt: stats.mtime.toISOString(),
              };
            } catch (err) {
              // A corrupt file must not hide the rest of the library; it stays
              // on disk for the user to repair and is only skipped from the
              // listing.
              this.logger.warn(
                `skipping unreadable team ${entry}: ${String(err)}`,
              );
              return null;
            }
          }),
      )
    ).filter((s): s is TeamSummary => s !== null);
    // Newest-updated first (ISO strings compare chronologically); slug breaks
    // ties so same-mtime files keep a stable order between listings.
    return summaries.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug),
    );
  }

  /**
   * The name a team's file states, read without the schema, so a file that
   * no longer validates still answers it. Null when the YAML itself does not
   * parse or names nothing; a missing file is still the store's 404.
   */
  async nameOf(slug: string): Promise<string | null> {
    const source = await this.readSource(this.fileFor(slug), slug);
    const doc = parseDocument(source);
    const name = doc.errors.length === 0 ? doc.get('name') : null;
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  }

  async get(slug: string): Promise<TeamWire> {
    const path = this.fileFor(slug);
    // One read serves both the 404 mapping and the parse — a second read
    // could race a concurrent delete into a raw ENOENT instead of the 404.
    const source = await this.readSource(path, slug);
    return {
      slug,
      team: parseTeamYaml(source),
      hash: teamFileHash(source),
    };
  }

  /**
   * Create a new team; slug derived from the name when not supplied.
   * The file lands via an exclusive atomic commit ({@link atomicCreate}), so
   * concurrent creates can never share or clobber one file and a crash never
   * leaves a half-written library entry: an explicit-slug collision surfaces
   * as TEAM_EXISTS, a derived-slug collision retries the next suffix.
   */
  async create(team: Team, slug?: string): Promise<TeamWire> {
    assertValidTeam(team);
    await mkdir(this.dir, { recursive: true });
    const content = serializeTeamYaml(team);
    if (slug) {
      // Refused rather than suffixed: the caller NAMED this slug, so quietly
      // landing the file under another one would hand back an address it did
      // not ask for.
      if (isReservedTeamSlug(slug)) {
        throw new BadRequestException(
          'TEAM_SLUG_RESERVED',
          `'${slug}' is a route of the teams API and cannot be a team slug`,
        );
      }
      try {
        await atomicCreate(this.fileFor(slug), content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ConflictException(
            'TEAM_EXISTS',
            `Team '${slug}' already exists`,
          );
        }
        throw err;
      }
      return { slug, team, hash: teamFileHash(content) };
    }
    const landed = await this.createDerivedSlug(
      slugifyTeamName(team.name),
      content,
    );
    return { slug: landed, team, hash: teamFileHash(content) };
  }

  /**
   * Save (upsert) a team, preserving hand-written YAML comments.
   *
   * With `baseHash`, a file that has changed since that version is refused
   * (`TEAM_CHANGED`) rather than overwritten: the builder's autosave and
   * an analysis's applied change both write this file, and a save from a
   * stale copy would silently undo the other's.
   */
  async save(slug: string, team: Team, baseHash?: string): Promise<TeamWire> {
    // One save per slug at a time: the hash check and the write must not
    // interleave with another save's, or both could pass against the same
    // version and the later rename would silently win.
    const previous = this.saving.get(slug) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.saveNow(slug, team, baseHash));
    this.saving.set(slug, next);
    try {
      return await next;
    } finally {
      if (this.saving.get(slug) === next) {
        this.saving.delete(slug);
      }
    }
  }

  private async saveNow(
    slug: string,
    team: Team,
    baseHash: string | undefined,
  ): Promise<TeamWire> {
    assertValidTeam(team);
    await mkdir(this.dir, { recursive: true });
    const path = this.fileFor(slug);
    const existing = (await this.exists(path))
      ? await readFile(path, 'utf8')
      : null;
    if (
      baseHash !== undefined &&
      (existing === null || teamFileHash(existing) !== baseHash)
    ) {
      // A file deleted since the copy was read is a change too: writing it
      // back would resurrect a team the user removed.
      throw new ConflictException(
        'TEAM_CHANGED',
        existing === null
          ? `Team '${slug}' was deleted since this copy was read`
          : `Team '${slug}' changed since this copy was read — reload it before saving`,
      );
    }
    const content = serializeTeamYaml(team, existing);
    await atomicWrite(path, content);
    return { slug, team, hash: teamFileHash(content) };
  }

  async delete(slug: string): Promise<void> {
    const path = this.fileFor(slug);
    if (!(await this.exists(path))) {
      throw new NotFoundException(
        'TEAM_NOT_FOUND',
        `No team '${slug}' in the library`,
      );
    }
    await rm(path);
  }

  /**
   * Copy an external `*.team.yaml` into the library (validated first). A
   * team still written as a node graph (a `.geniro.yaml` or an older export)
   * is converted and written in the team shape.
   */
  async importFrom(sourcePath: string): Promise<TeamWire> {
    let source: string;
    try {
      source = await readFile(sourcePath, 'utf8');
    } catch {
      throw new BadRequestException(
        'TEAM_IMPORT_UNREADABLE',
        `Cannot read ${sourcePath}`,
      );
    }
    const { team, legacyNotes } = parseTeamYamlDocument(source);
    if (legacyNotes !== null) {
      const strict = TeamYamlSchema.safeParse(team);
      if (!strict.success) {
        throw new BadRequestException(
          'TEAM_YAML_INVALID',
          `Converted from a node graph, this team would not load: ${strict.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
    }
    assertValidTeam(team);
    const content = legacyNotes === null ? source : serializeTeamYaml(team);
    await mkdir(this.dir, { recursive: true });
    const fileName = basename(sourcePath);
    const suffix = [TEAM_SUFFIX, LEGACY_TEAM_SUFFIX].find((s) =>
      fileName.endsWith(s),
    );
    const importedName = suffix ? fileName.slice(0, -suffix.length) : team.name;
    // A team file lands verbatim — the user's comments come along. The slug
    // commits through the same exclusive loop as create(): a stat-then-write
    // here was a TOCTOU that let a racing writer on the same slug be clobbered.
    const slug = await this.createDerivedSlug(
      slugifyTeamName(importedName),
      content,
    );
    return { slug, team, hash: teamFileHash(content) };
  }

  /** Export a library team to an external path chosen by the user. */
  async exportTo(slug: string, targetPath: string): Promise<void> {
    if (!/\.ya?ml$/i.test(targetPath)) {
      throw new BadRequestException(
        'TEAM_EXPORT_FAILED',
        'Export target must be a .yaml file',
      );
    }
    const path = this.fileFor(slug);
    const source = await this.readSource(path, slug);
    try {
      await writeFile(targetPath, source, 'utf8');
    } catch {
      throw new BadRequestException(
        'TEAM_EXPORT_FAILED',
        `Cannot write ${targetPath}`,
      );
    }
  }

  private async readSource(path: string, slug: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new NotFoundException(
        'TEAM_NOT_FOUND',
        `No team '${slug}' in the library`,
      );
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The slug {@link create} would derive for `name` if it ran now — the same
   * reserved-base and `-N` walk as {@link createDerivedSlug}, asked by `stat`
   * and writing nothing. It describes the present only: a create landing
   * between this answer and the write takes the slug, and the later
   * `create(team, slug)` is refused `TEAM_EXISTS`.
   */
  async freeDerivedSlug(name: string): Promise<string> {
    for (const candidate of derivedSlugCandidates(slugifyTeamName(name))) {
      if (!(await this.exists(this.fileFor(candidate)))) {
        return candidate;
      }
    }
    throw new InternalException(
      'TEAM_SLUG_EXHAUSTED',
      'derived slug candidates never run out',
    );
  }

  /**
   * Land `content` at the first free suffixed candidate of `base` through the
   * exclusive {@link atomicCreate} commit — the one slug-allocation path shared
   * by create() and importFrom(), so no sibling reintroduces the
   * check-then-rename TOCTOU a stat loop + rename-over had.
   *
   * A base a ROUTE owns (`runs`, `import`) starts at `-1` rather than being
   * tried as-is: the file would land, list and then never open, because the
   * static route answers its address (see `RESERVED_TEAM_SLUGS`).
   */
  private async createDerivedSlug(
    base: string,
    content: string,
  ): Promise<string> {
    for (const candidate of derivedSlugCandidates(base)) {
      try {
        await atomicCreate(this.fileFor(candidate), content);
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    }
    throw new InternalException(
      'TEAM_SLUG_EXHAUSTED',
      'derived slug candidates never run out',
    );
  }
}

/**
 * The slugs a derived name is tried under, in order — the one walk
 * {@link TeamStoreService.createDerivedSlug} and `freeDerivedSlug` share,
 * so the slug a card names is the slug a create would pick.
 */
function* derivedSlugCandidates(base: string): Generator<string> {
  yield isReservedTeamSlug(base) ? `${base}-1` : base;
  for (let attempt = 2; ; attempt++) {
    yield `${base}-${attempt}`;
  }
}
