import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { environment } from '../../../environments';
import { atomicWrite } from '../../../utils/atomic-file';
import { RunDao } from '../../agents/dao/run.dao';
import { sniffImageExtension } from '../../agents/utils/artifact-image-policy';
import { MAX_AVATAR_BYTES } from '../teams.types';
import { TEAM_BACKUP_DIR } from '../utils/team-backup';
import { TEAM_SUFFIX, TEAMS_DIR_NAME } from '../utils/team-library-paths';

/** `<userData>/` directory the members' uploaded pictures live in. */
export const AVATARS_DIR_NAME = 'avatars';

/** An upload this young may not be in any team yet, so a sweep leaves it. */
export const AVATAR_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** The whole-folder sweep first runs this long after boot, off the listen path, then once per grace. */
const BOOT_SWEEP_DELAY_MS = 15_000;

/** Constructor options — test seams, not user config. */
export interface AvatarStoreOptions {
  /** Avatars root (test seam); default `<userData>/avatars`. */
  root?: string;
  /** Team library directory (test seam); default `<userData>/teams`. */
  teamsDir?: string;
  /** Clock (test seam). */
  now?: () => number;
}

const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

type AvatarExtension = keyof typeof MEDIA_TYPES;

const AVATAR_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
const AVATAR_IDS_IN_TEXT = /[0-9a-f]{64}\.(?:png|jpg|gif|webp)/g;

/** Every stored-picture id a team file's text names. */
export function avatarIdsIn(text: string | null): Set<string> {
  return new Set(text === null ? [] : text.match(AVATAR_IDS_IN_TEXT));
}

/**
 * The pictures a user uploads as member avatars, stored as files under
 * `<userData>/avatars/` and named by the sha256 of their bytes, so saving the
 * same picture twice writes once and an id can be searched for as plain text
 * in any stored copy of a team.
 *
 * A team names its picture by that id; nothing else keeps one alive. After a
 * library write a sweep looks only at the ids it dropped; after boot and then
 * hourly it looks at every file, so an upload no team ever saved goes too. A file is
 * removed once no library team, backup or run snapshot names it. Recorded team
 * versions never hold a picture (`canonicalGraphOf` leaves faces out).
 */
@Injectable()
export class AvatarStoreService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AvatarStoreService.name);
  private readonly root: string;
  private readonly teamsDir: string;
  private readonly now: () => number;
  private sweeping: Promise<unknown> = Promise.resolve();
  private bootTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runs: RunDao,
    options: AvatarStoreOptions = {},
  ) {
    this.root = options.root ?? join(environment.userDataDir, AVATARS_DIR_NAME);
    this.teamsDir =
      options.teamsDir ?? join(environment.userDataDir, TEAMS_DIR_NAME);
    this.now = options.now ?? Date.now;
  }

  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.sweepAll();
      this.sweepTimer = setInterval(
        () => void this.sweepAll(),
        AVATAR_SWEEP_GRACE_MS,
      );
      this.sweepTimer.unref();
    }, BOOT_SWEEP_DELAY_MS);
    this.bootTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async save(bytes: Buffer): Promise<string> {
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new BadRequestException(
        'AVATAR_TOO_LARGE',
        `a picture may be at most ${MAX_AVATAR_BYTES / 1024 / 1024}MB`,
      );
    }
    const sniffed = sniffImageExtension(bytes);
    if (sniffed === null || sniffed === 'avif') {
      throw new BadRequestException(
        'AVATAR_NOT_AN_IMAGE',
        'not a png, jpeg, gif or webp image',
      );
    }
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${sniffed}`;
    const path = this.pathOf(id);
    // On the sweeps' own chain, so a removal never lands between the check
    // and the write.
    const write = this.sweeping.then(async () => {
      await mkdir(this.root, { recursive: true });
      if (await this.exists(path)) {
        // Saving the same picture again must restart its sweep grace.
        const touched = new Date(this.now());
        await utimes(path, touched, touched);
      } else {
        await atomicWrite(path, bytes);
      }
    });
    this.sweeping = write.catch(() => undefined);
    await write;
    return id;
  }

  async read(id: string): Promise<{ mediaType: string; base64: string }> {
    const path = this.pathOf(id);
    const extension = id.slice(id.lastIndexOf('.') + 1) as AvatarExtension;
    try {
      const bytes = await readFile(path);
      return {
        mediaType: MEDIA_TYPES[extension],
        base64: bytes.toString('base64'),
      };
    } catch {
      throw new NotFoundException('AVATAR_NOT_FOUND', 'no such avatar');
    }
  }

  /**
   * Delete those of `dropped` — the ids a library write no longer names — that
   * no stored copy of a team names any more, and answer how many went. Sweeps
   * run one after another and never throw.
   */
  sweep(dropped: Iterable<string>): Promise<number> {
    const candidates = [...dropped].filter((id) => AVATAR_ID.test(id));
    if (candidates.length === 0) {
      return Promise.resolve(0);
    }
    const run = this.sweeping.then(() => this.sweepNow(candidates));
    this.sweeping = run;
    return run;
  }

  /** Sweep every stored picture, named by a team or not. Never throws. */
  async sweepAll(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`avatar sweep stopped: ${String(error)}`);
      }
      return 0;
    }
    return this.sweep(names);
  }

  private async sweepNow(candidates: readonly string[]): Promise<number> {
    let removed = 0;
    try {
      const old = await this.oldOf(candidates);
      if (old.length === 0) {
        return 0;
      }
      const texts = await this.libraryTexts();
      for (const id of old) {
        if (texts.some((text) => text.includes(id))) {
          continue;
        }
        if (await this.runs.teamSnapshotMentions(id)) {
          continue;
        }
        // An upload of the same picture since the check restarts its grace.
        if ((await this.oldOf([id])).length === 0) {
          continue;
        }
        await rm(this.pathOf(id), { force: true });
        removed += 1;
      }
    } catch (error) {
      this.logger.warn(`avatar sweep stopped: ${String(error)}`);
    }
    return removed;
  }

  /** The candidates whose file exists and is past the grace. */
  private async oldOf(candidates: readonly string[]): Promise<string[]> {
    const cutoff = this.now() - AVATAR_SWEEP_GRACE_MS;
    const old: string[] = [];
    for (const id of candidates) {
      try {
        if ((await stat(this.pathOf(id))).mtimeMs < cutoff) {
          old.push(id);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return old;
  }

  /** Every library team file and every backup, as text; a file that cannot be read stops the sweep. */
  private async libraryTexts(): Promise<string[]> {
    const backups = join(this.teamsDir, TEAM_BACKUP_DIR);
    const paths = [
      ...(await this.namesIn(this.teamsDir, (name) =>
        name.endsWith(TEAM_SUFFIX),
      )),
      ...(await this.namesIn(backups, (name) => name.endsWith('.yaml'))),
    ];
    return Promise.all(paths.map((path) => readFile(path, 'utf8')));
  }

  private async namesIn(
    dir: string,
    wanted: (name: string) => boolean,
  ): Promise<string[]> {
    try {
      return (await readdir(dir)).filter(wanted).map((name) => join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private pathOf(id: string): string {
    if (!AVATAR_ID.test(id)) {
      throw new NotFoundException('AVATAR_NOT_FOUND', 'no such avatar');
    }
    return join(this.root, id);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
