import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { environment } from '../../../environments';
import { atomicWrite } from '../../../utils/atomic-file';
import { backUpFile } from '../../teams/utils/team-backup';
import { teamFileHash } from '../../teams/utils/team-hash';
import {
  PLUGIN_APPROVED_DIR,
  PLUGIN_BACKUP_DIR,
  PLUGIN_BACKUPS_KEPT,
  PLUGIN_SLUG_RE,
  PLUGIN_SUFFIX,
  PLUGINS_DIR_NAME,
  type StoredPlugin,
} from '../plugins.types';
import { readPluginText } from '../utils/plugin-file';
import { PluginEventBus } from './plugin-events.bus';

export interface PluginStoreOptions {
  /** Directory override (test seam); default `<userData>/plugins`. */
  pluginsDir?: string;
}

/**
 * The plugin files: `<userData>/plugins/<slug>.plugin.yaml`, each with the
 * text the user approved copied to `.approved/<slug>.plugin.yaml`. A plugin
 * is approved only while its text equals that copy, so a hand edit is found
 * on every read without a watcher. A write geniro makes on the user's press
 * puts the file first and the approved copy last, each atomically, so a
 * crash between them leaves the plugin unapproved, never approved by
 * accident. Writes are serialized per slug and back the old file up first.
 */
@Injectable()
export class PluginStoreService {
  readonly dir: string;
  private readonly saving = new Map<string, Promise<unknown>>();

  constructor(
    options: PluginStoreOptions = {},
    private readonly events?: PluginEventBus,
  ) {
    this.dir =
      options.pluginsDir ?? join(environment.userDataDir, PLUGINS_DIR_NAME);
  }

  pathOf(slug: string): string {
    this.assertSlug(slug);
    return join(this.dir, `${slug}${PLUGIN_SUFFIX}`);
  }

  private approvedPathOf(slug: string): string {
    this.assertSlug(slug);
    return join(this.dir, PLUGIN_APPROVED_DIR, `${slug}${PLUGIN_SUFFIX}`);
  }

  async list(): Promise<StoredPlugin[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const slugs = names
      .filter((name) => name.endsWith(PLUGIN_SUFFIX))
      .map((name) => name.slice(0, -PLUGIN_SUFFIX.length))
      .filter((slug) => PLUGIN_SLUG_RE.test(slug))
      .sort();
    const read = await Promise.all(slugs.map((slug) => this.get(slug)));
    return read.filter((plugin): plugin is StoredPlugin => plugin !== null);
  }

  /** The plugin as it stands on disk, or null when there is no such file. */
  async get(slug: string): Promise<StoredPlugin | null> {
    const text = await this.readSource(this.pathOf(slug));
    if (text === null) {
      return null;
    }
    const approvedText = await this.readSource(this.approvedPathOf(slug));
    return storedOf(slug, text, approvedText);
  }

  async getOrThrow(slug: string): Promise<StoredPlugin> {
    const stored = await this.get(slug);
    if (stored === null) {
      throw new NotFoundException('PLUGIN_NOT_FOUND', `No plugin ${slug}`);
    }
    return stored;
  }

  /**
   * Write `text` as the plugin's file. `baseHash` is the version the caller
   * read: a string must still be the file's, null means the caller saw no
   * file, undefined skips the check. `approve` also records the text as
   * approved — only for a write the user pressed for.
   */
  write(
    slug: string,
    text: string,
    options: { baseHash?: string | null; approve: boolean },
  ): Promise<StoredPlugin> {
    return this.serialized(slug, async () => {
      const path = this.pathOf(slug);
      const existing = await this.readSource(path);
      this.assertBase(slug, existing, options.baseHash);
      const read = readPluginText(text);
      if (!read.ok) {
        throw new BadRequestException('PLUGIN_INVALID', read.error);
      }
      if (existing !== null) {
        await this.backUp(slug, existing);
      }
      await mkdir(this.dir, { recursive: true });
      await atomicWrite(path, text);
      if (options.approve) {
        await this.writeApproved(slug, text);
      }
      this.events?.publish({ slug });
      return storedOf(
        slug,
        text,
        options.approve ? text : await this.readSource(this.approvedPathOf(slug)),
      );
    });
  }

  /** Approve the text the caller saw; refused `PLUGIN_CHANGED` once the file moved on. */
  approve(slug: string, hash: string): Promise<StoredPlugin> {
    return this.serialized(slug, async () => {
      const text = await this.readSource(this.pathOf(slug));
      if (text === null) {
        throw new NotFoundException('PLUGIN_NOT_FOUND', `No plugin ${slug}`);
      }
      this.assertBase(slug, text, hash);
      const read = readPluginText(text);
      if (!read.ok) {
        throw new BadRequestException('PLUGIN_INVALID', read.error);
      }
      await this.writeApproved(slug, text);
      this.events?.publish({ slug });
      return storedOf(slug, text, text);
    });
  }

  /**
   * Rewrite the file with `change` made to it; an approved plugin stays
   * approved, because the user made the change.
   */
  update(
    slug: string,
    baseHash: string,
    change: (text: string) => string,
  ): Promise<StoredPlugin> {
    return this.serialized(slug, async () => {
      const path = this.pathOf(slug);
      const existing = await this.readSource(path);
      if (existing === null) {
        throw new NotFoundException('PLUGIN_NOT_FOUND', `No plugin ${slug}`);
      }
      this.assertBase(slug, existing, baseHash);
      const approvedText = await this.readSource(this.approvedPathOf(slug));
      const wasApproved = approvedText === existing;
      const text = change(existing);
      const read = readPluginText(text);
      if (!read.ok) {
        throw new BadRequestException('PLUGIN_INVALID', read.error);
      }
      await this.backUp(slug, existing);
      await atomicWrite(path, text);
      if (wasApproved) {
        await this.writeApproved(slug, text);
      }
      this.events?.publish({ slug });
      return storedOf(slug, text, wasApproved ? text : approvedText);
    });
  }

  /** Remove a plugin and its approved copy after backing the file up; false when there was none. */
  delete(slug: string): Promise<boolean> {
    return this.serialized(slug, async () => {
      const path = this.pathOf(slug);
      const existing = await this.readSource(path);
      await rm(this.approvedPathOf(slug), { force: true });
      if (existing === null) {
        return false;
      }
      await this.backUp(slug, existing);
      await rm(path, { force: true });
      this.events?.publish({ slug });
      return true;
    });
  }

  private async writeApproved(slug: string, text: string): Promise<void> {
    await mkdir(join(this.dir, PLUGIN_APPROVED_DIR), { recursive: true });
    await atomicWrite(this.approvedPathOf(slug), text);
  }

  private assertSlug(slug: string): void {
    if (!PLUGIN_SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'PLUGIN_SLUG_INVALID',
        `A plugin slug is lowercase letters, digits, - and _: ${slug}`,
      );
    }
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
        'PLUGIN_CHANGED',
        current === null
          ? `Plugin ${slug} was removed since this copy was read`
          : baseHash === null
            ? `A plugin named ${slug} already exists`
            : `Plugin ${slug} changed since this copy was read — reload it`,
      );
    }
  }

  private async backUp(slug: string, source: string): Promise<void> {
    const dir = join(this.dir, PLUGIN_BACKUP_DIR);
    await backUpFile(dir, slug, source);
    const names = (await readdir(dir).catch(() => [] as string[])).filter(
      (name) => name.startsWith(`${slug}.`) && name.endsWith('.yaml'),
    );
    if (names.length <= PLUGIN_BACKUPS_KEPT) {
      return;
    }
    const dated = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
      })),
    );
    dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    for (const { name } of dated.slice(PLUGIN_BACKUPS_KEPT)) {
      await rm(join(dir, name), { force: true });
    }
  }

  private async readSource(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new BadRequestException(
        'PLUGIN_UNREADABLE',
        `Cannot read the plugin file: ${(error as Error).message}`,
      );
    }
  }

  private serialized<T>(slug: string, work: () => Promise<T>): Promise<T> {
    const previous = this.saving.get(slug) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.saving.set(slug, next);
    void next
      .finally(() => {
        if (this.saving.get(slug) === next) {
          this.saving.delete(slug);
        }
      })
      .catch(() => undefined);
    return next;
  }
}

/** A plugin's text read into its state: invalid, approved (text equals the approved copy) or changed. */
export function storedOf(
  slug: string,
  text: string,
  approvedText: string | null,
): StoredPlugin {
  const read = readPluginText(text);
  const hash = teamFileHash(text);
  if (!read.ok) {
    return {
      slug,
      text,
      hash,
      approvedText,
      state: 'invalid',
      plugin: null,
      error: read.error,
    };
  }
  return {
    slug,
    text,
    hash,
    approvedText,
    state: approvedText === text ? 'approved' : 'changed',
    plugin: read.plugin,
    error: null,
  };
}
