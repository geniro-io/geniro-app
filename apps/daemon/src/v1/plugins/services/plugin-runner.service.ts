import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { pointerGet } from '../../agents/utils/a2ui/a2ui-apply';
import {
  type ManagedCommandOptions,
  type ManagedCommandResult,
  runManagedCommand,
} from '../../agents/utils/managed-command';
import { maskedTail, SECRET_MARGIN } from '../../agents/utils/masked-tail';
import { isWithinDirectory } from '../../agents/utils/path-within';
import {
  existingDirectory,
  resolveValidDirectory,
} from '../../agents/utils/resolve-directory';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import {
  type Plugin,
  PLUGIN_BUTTON_OUTPUT_TAIL_MAX,
  PLUGIN_ENV_VALUE_MAX,
  PLUGIN_ERROR_TEXT_MAX,
  PLUGIN_MIN_REFRESH_MS,
  PLUGIN_NOT_JSON_HEAD,
  PLUGIN_OUTPUT_MAX_CHARS,
  type PluginBlock,
  type PluginPressResult,
  type PluginRunResult,
  type StoredPlugin,
} from '../plugins.types';
import { resolvePluginFolder } from '../utils/plugin-file';
import { PluginStoreService } from './plugin-store.service';

/** The shell line form every plugin command and button runs as. */
const SHELL = '/bin/sh';

export type PluginCommandRunner = (
  options: ManagedCommandOptions,
) => Promise<ManagedCommandResult>;

/** Where one run's plugins run, and the folders that make a plugin's list match it. */
interface RunPlace {
  folder: string;
  candidates: string[];
}

interface CachedRun {
  result: PluginRunResult;
  hash: string;
}

function keyOf(...parts: string[]): string {
  return parts.join('\u0000');
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Whether one of `candidates` is inside one of the plugin's folders; an empty list matches every folder. */
export function pluginMatchesFolder(
  plugin: Pick<Plugin, 'resolvedFolders'>,
  candidates: readonly string[],
): boolean {
  if (plugin.resolvedFolders.length === 0) {
    return true;
  }
  return candidates.some((candidate) =>
    plugin.resolvedFolders.some((folder) =>
      isWithinDirectory(candidate.toLowerCase(), folder.toLowerCase()),
    ),
  );
}

/**
 * Runs approved plugin commands in a run's folder and keeps the last result
 * per (plugin, folder) in memory — lost on restart, by decision. One run at
 * a time per (plugin, folder): a second caller joins the first. The file is
 * read once per run, and the command run is the one parsed from that same
 * text, so an edit between the check and the spawn cannot slip through.
 */
@Injectable()
export class PluginRunnerService {
  private readonly cache = new Map<string, CachedRun>();
  private readonly inFlight = new Map<string, Promise<PluginRunResult>>();
  private readonly pressing = new Set<string>();
  private runCommand: PluginCommandRunner = runManagedCommand;

  constructor(
    private readonly store: PluginStoreService,
    private readonly processes: ProcessRegistry,
    private readonly runs: RunDao,
    private readonly roots: ProjectRootsService,
  ) {}

  /** Test seam: the process runner. */
  useCommandRunner(runner: PluginCommandRunner): void {
    this.runCommand = runner;
  }

  /** The newest result of `slug` in any folder, for the Settings list. */
  lastRunAt(slug: string): string | null {
    let newest: string | null = null;
    for (const [key, cached] of this.cache) {
      if (
        key.startsWith(keyOf(slug, '')) &&
        (newest === null || cached.result.at > newest)
      ) {
        newest = cached.result.at;
      }
    }
    return newest;
  }

  /** The enabled plugins whose folders take in this run's folder, with their last result here. */
  async blocksForRun(runId: string): Promise<PluginBlock[]> {
    const place = await this.placeOf(runId);
    if (place === null) {
      return [];
    }
    const blocks: PluginBlock[] = [];
    for (const stored of await this.store.list()) {
      const plugin = stored.plugin;
      if (
        plugin === null ||
        !plugin.enabled ||
        !pluginMatchesFolder(plugin, place.candidates)
      ) {
        continue;
      }
      blocks.push({
        slug: stored.slug,
        name: plugin.name,
        state: stored.state,
        folder: place.folder,
        view: plugin.view,
        refreshMinutes: plugin.refresh_minutes,
        buttons: plugin.buttons.map(({ id, command, confirm }) => ({
          id,
          command,
          confirm,
        })),
        result:
          this.cache.get(keyOf(stored.slug, place.folder))?.result ?? null,
      });
    }
    return blocks;
  }

  /**
   * The plugin's data in this run's folder: the cached result while it is
   * fresh (never older than `refresh_minutes`, never re-run within a
   * minute), else a run of its approved command.
   */
  async run(
    slug: string,
    runId: string,
    options: { force?: boolean; skipCache?: boolean } = {},
  ): Promise<PluginRunResult> {
    return this.runAt(slug, await this.requirePlace(runId), options);
  }

  /** The same run in a folder the user picked, as from Settings; it fills the cache the chats there read. */
  async runInFolder(
    slug: string,
    folder: string,
    options: { force?: boolean } = {},
  ): Promise<PluginRunResult> {
    const resolved = resolveValidDirectory(
      resolvePluginFolder(folder) ?? folder,
      {
        errorCode: 'PLUGIN_FOLDER_INVALID',
        noun: 'folder',
      },
    );
    return this.runAt(slug, await this.placeAt(resolved), options);
  }

  private async runAt(
    slug: string,
    place: RunPlace,
    options: { force?: boolean; skipCache?: boolean },
  ): Promise<PluginRunResult> {
    const stored = await this.store.getOrThrow(slug);
    const plugin = this.runnable(stored, place);
    const key = keyOf(slug, place.folder);
    const joined = this.inFlight.get(key);
    if (joined !== undefined) {
      return options.skipCache
        ? joined
            .catch(() => undefined)
            .then(() => this.runAt(slug, place, options))
        : joined;
    }
    const cached = this.cache.get(key);
    if (
      !options.skipCache &&
      cached !== undefined &&
      cached.hash === stored.hash
    ) {
      const age = Date.now() - Date.parse(cached.result.at);
      const fresh = options.force
        ? age < PLUGIN_MIN_REFRESH_MS
        : age <
          Math.max(plugin.refresh_minutes * 60_000, PLUGIN_MIN_REFRESH_MS);
      if (fresh) {
        return cached.result;
      }
    }
    const running = this.runData(slug, plugin, place.folder)
      .then((result) => {
        if (this.inFlight.get(key) === running) {
          this.cache.set(key, { result, hash: stored.hash });
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key) === running) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, running);
    return running;
  }

  /**
   * Run one of the plugin's buttons in this run's folder. `dataAt` is the
   * result the user saw: a cache that moved on since is refused
   * `PLUGIN_DATA_CHANGED`, so values reach the command only from data the
   * user was shown — read here from the daemon's own copy, never the client's.
   */
  async press(
    slug: string,
    buttonId: string,
    runId: string,
    dataAt: string,
  ): Promise<PluginPressResult> {
    const place = await this.requirePlace(runId);
    const stored = await this.store.getOrThrow(slug);
    const plugin = this.runnable(stored, place);
    const button = plugin.buttons.find(
      (candidate) => candidate.id === buttonId,
    );
    if (button === undefined) {
      throw new NotFoundException(
        'PLUGIN_BUTTON_NOT_FOUND',
        `Plugin ${slug} has no button ${buttonId}`,
      );
    }
    const cached = this.cache.get(keyOf(slug, place.folder));
    if (
      cached === undefined ||
      cached.result.at !== dataAt ||
      cached.hash !== stored.hash
    ) {
      throw new ConflictException(
        'PLUGIN_DATA_CHANGED',
        'The plugin refreshed since you saw it; look again and press once more',
      );
    }
    const env: Record<string, string> = {};
    for (const [name, pointer] of Object.entries(button.env ?? {})) {
      const value = pointerGet(cached.result.data, pointer);
      if (value === undefined || value === null) {
        throw new BadRequestException(
          'PLUGIN_NO_DATA',
          `The data has nothing at ${pointer || '/'} for ${name}`,
        );
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text.length > PLUGIN_ENV_VALUE_MAX || text.includes('\u0000')) {
        throw new BadRequestException(
          'PLUGIN_VALUE_TOO_LONG',
          `The value at ${pointer || '/'} for ${name} is longer than ${PLUGIN_ENV_VALUE_MAX} characters`,
        );
      }
      env[name] = text;
    }
    const busyKey = keyOf(slug, buttonId, place.folder);
    if (this.pressing.has(busyKey)) {
      throw new ConflictException(
        'PLUGIN_BUSY',
        'This button is already running here',
      );
    }
    this.pressing.add(busyKey);
    try {
      const result = await this.runCommand({
        label: `plugin-button:${slug}:${buttonId}`,
        command: SHELL,
        args: ['-c', button.command],
        cwd: place.folder,
        timeoutMs: button.timeout_minutes * 60_000,
        processes: this.processes,
        env,
        maxOutputChars: PLUGIN_BUTTON_OUTPUT_TAIL_MAX + SECRET_MARGIN,
        keepOutput: 'tail',
        endGroupOnExit: true,
      });
      const outputTail = maskedTail(
        result.output ?? '',
        PLUGIN_BUTTON_OUTPUT_TAIL_MAX,
      );
      void this.run(slug, runId, { skipCache: true }).catch(() => undefined);
      if (result.spawnError !== undefined) {
        return {
          exitCode: null,
          outputTail,
          error: `could not start: ${result.spawnError}`,
        };
      }
      if (result.timedOut) {
        return {
          exitCode: null,
          outputTail,
          error: `timed out after ${button.timeout_minutes} min`,
        };
      }
      return {
        exitCode: result.code,
        outputTail,
        error:
          result.code === 0
            ? null
            : result.code === null
              ? 'killed by a signal'
              : `exit ${result.code}`,
      };
    } finally {
      this.pressing.delete(busyKey);
    }
  }

  /** Forget every result of `slug`, as after a delete. */
  forget(slug: string): void {
    const prefix = keyOf(slug, '');
    for (const map of [this.cache, this.inFlight]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
        }
      }
    }
  }

  private runnable(stored: StoredPlugin, place: RunPlace): Plugin {
    if (stored.plugin === null) {
      throw new BadRequestException(
        'PLUGIN_INVALID',
        stored.error ?? 'the plugin file does not read',
      );
    }
    if (!pluginMatchesFolder(stored.plugin, place.candidates)) {
      throw new BadRequestException(
        'PLUGIN_FOLDER_MISMATCH',
        `Plugin ${stored.slug} is not set to show in ${place.folder}`,
      );
    }
    if (stored.state !== 'approved') {
      throw new BadRequestException(
        'PLUGIN_NOT_APPROVED',
        `Plugin ${stored.slug} changed since it was approved; review and approve it first`,
      );
    }
    if (!stored.plugin.enabled) {
      throw new BadRequestException(
        'PLUGIN_DISABLED',
        `Plugin ${stored.slug} is switched off`,
      );
    }
    return stored.plugin;
  }

  private async requirePlace(runId: string): Promise<RunPlace> {
    const place = await this.placeOf(runId);
    if (place === null) {
      throw new BadRequestException(
        'PLUGIN_FOLDER_INVALID',
        'This thread has no folder to run a plugin in',
      );
    }
    return place;
  }

  /**
   * The run's folder and what counts as being in it: the folder itself and,
   * for a board card's worktree or another git worktree, the folder it was
   * cut from. Null for a run that is gone or has no usable folder.
   */
  private async placeOf(runId: string): Promise<RunPlace | null> {
    const run = await this.runs.getById(runId);
    const folder =
      run === null || run.cwd === null ? null : existingDirectory(run.cwd);
    return folder === null ? null : this.placeAt(folder);
  }

  private async placeAt(folder: string): Promise<RunPlace> {
    const roots = await this.roots.rootsOf([folder]);
    const root = roots.get(folder);
    const rootFolder = root === undefined ? null : existingDirectory(root);
    return {
      folder,
      candidates:
        rootFolder === null || rootFolder === folder
          ? [folder]
          : [folder, rootFolder],
    };
  }

  private async runData(
    slug: string,
    plugin: Plugin,
    folder: string,
  ): Promise<PluginRunResult> {
    const result = await this.runCommand({
      label: `plugin:${slug}`,
      command: SHELL,
      args: ['-c', plugin.command],
      cwd: folder,
      timeoutMs: plugin.timeout_seconds * 1000,
      processes: this.processes,
      maxOutputChars: PLUGIN_OUTPUT_MAX_CHARS,
      keepOutput: 'head',
      endGroupOnExit: true,
    });
    const at = new Date().toISOString();
    const stderrTail = cut(
      redactSecrets(result.stderr.slice(-PLUGIN_ERROR_TEXT_MAX * 2)),
      PLUGIN_ERROR_TEXT_MAX,
    );
    const failed = (error: string): PluginRunResult => ({
      at,
      data: null,
      error: cut(redactSecrets(error), PLUGIN_ERROR_TEXT_MAX),
      exitCode: result.code,
      stderrTail,
    });
    if (result.spawnError !== undefined) {
      return failed(`could not start: ${result.spawnError}`);
    }
    if (result.timedOut) {
      return failed(`timed out after ${plugin.timeout_seconds} s`);
    }
    if (result.code !== 0) {
      return failed(
        result.code === null ? 'killed by a signal' : `exit ${result.code}`,
      );
    }
    if (result.stdout.length >= PLUGIN_OUTPUT_MAX_CHARS) {
      return failed('the command printed more than 1 MB');
    }
    try {
      return {
        at,
        data: JSON.parse(result.stdout) as unknown,
        error: null,
        exitCode: 0,
        stderrTail,
      };
    } catch {
      return failed(
        `the command did not print JSON: ${result.stdout.slice(0, PLUGIN_NOT_JSON_HEAD)}`,
      );
    }
  }
}
