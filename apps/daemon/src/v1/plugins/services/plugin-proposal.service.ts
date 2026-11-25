import { Injectable } from '@nestjs/common';

import type { HostPluginProposal } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { existingDirectory } from '../../agents/utils/resolve-directory';
import {
  PLUGIN_SAMPLE_MAX_CHARS,
  PLUGIN_SLUG_RE,
  type SavePluginInput,
} from '../plugins.types';
import {
  type PluginFileInput,
  pluginFileText,
  readPluginText,
} from '../utils/plugin-file';
import { PluginStoreService } from './plugin-store.service';

export type PluginProposalRead =
  { ok: true; proposal: HostPluginProposal } | { ok: false; error: string };

/** A name made into a free slug: lowercase, dashes, `-2`, `-3`… when taken. */
export function slugOfName(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'plugin';
  return /^[a-z0-9]/.test(base) ? base : `p-${base}`;
}

/**
 * Turns a `save_plugin` call into the card it raises: the file text Approve
 * would write, checked as the store checks it, and what the card shows. A
 * slug naming an existing plugin is an update quoting the hash it was read
 * at; folders left out are the chat's own folder for a new plugin and the
 * plugin's own for an update. Nothing is run and nothing is written here.
 */
@Injectable()
export class PluginProposalService {
  constructor(
    private readonly store: PluginStoreService,
    private readonly runs: RunDao,
  ) {}

  async prepare(
    runId: string,
    input: SavePluginInput,
  ): Promise<PluginProposalRead> {
    if (input.slug !== undefined && !PLUGIN_SLUG_RE.test(input.slug)) {
      return {
        ok: false,
        error: '/slug: lowercase letters, digits, - and _ only',
      };
    }
    const existing =
      input.slug === undefined ? null : await this.store.get(input.slug);
    const slug = input.slug ?? (await this.freeSlug(slugOfName(input.name)));
    let folders = input.folders ?? existing?.plugin?.folders;
    if (folders === undefined) {
      const run = await this.runs.getById(runId);
      const folder = run?.cwd ? existingDirectory(run.cwd) : null;
      if (folder === null) {
        return {
          ok: false,
          error:
            '/folders: this chat has no folder; name the folders the block shows in',
        };
      }
      folders = [folder];
    }
    if (
      input.sample !== undefined &&
      JSON.stringify(input.sample).length > PLUGIN_SAMPLE_MAX_CHARS
    ) {
      return {
        ok: false,
        error: `/sample: at most ${PLUGIN_SAMPLE_MAX_CHARS / 1024} KB; trim it to a few rows`,
      };
    }
    const file: PluginFileInput = {
      name: input.name,
      ...(existing?.plugin && !existing.plugin.enabled
        ? { enabled: false }
        : {}),
      folders,
      ...(input.refresh_minutes === undefined
        ? {}
        : { refresh_minutes: input.refresh_minutes }),
      ...(input.timeout_seconds === undefined
        ? {}
        : { timeout_seconds: input.timeout_seconds }),
      command: input.command,
      view: input.view,
      ...(input.buttons === undefined || input.buttons.length === 0
        ? {}
        : { buttons: input.buttons }),
    };
    const text = pluginFileText(file, existing?.text ?? null);
    const read = readPluginText(text);
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    const plugin = read.plugin;
    return {
      ok: true,
      proposal: {
        slug,
        name: plugin.name,
        text,
        previousText: existing?.text ?? null,
        baseHash: existing?.hash ?? null,
        command: plugin.command,
        folders: plugin.folders,
        refreshMinutes: plugin.refresh_minutes,
        timeoutSeconds: plugin.timeout_seconds,
        buttons: plugin.buttons.map(({ id, command, confirm }) => ({
          id,
          command,
          confirm,
        })),
        view: plugin.view,
        sample: input.sample ?? null,
      },
    };
  }

  private async freeSlug(base: string): Promise<string> {
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`;
      if ((await this.store.get(slug)) === null) {
        return slug;
      }
    }
    return `${base}-${Date.now()}`;
  }
}
