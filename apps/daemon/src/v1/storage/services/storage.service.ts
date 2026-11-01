import { existsSync } from 'node:fs';
import { readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { environment } from '../../../environments';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { ChatService } from '../../agents/services/chat.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import {
  DEBUG_LOG_DIR_NAME,
  debugSink,
} from '../../diagnostics/utils/debug-sink';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TASK_ATTACHMENTS_DIR_NAME } from '../../tasks/utils/task-attachments';
import { TEAM_BACKUP_DIR } from '../../teams/utils/team-backup';
import {
  type SeenInodes,
  STORAGE_GROUP_IDS,
  type StorageClassifier,
  type StorageCleanOption,
  type StorageCleanTarget,
  type StorageEntry,
  type StorageGroup,
  type StorageGroupId,
  type StorageJob,
  type StorageUsage,
} from '../storage.types';
import { listNames, measurePath, newSeenInodes } from '../utils/disk-usage';
import {
  COMPACTION_MARKER_FILE,
  RUN_FILE_DIRS,
  storageClassifier,
  TEAMS_DIR_NAME,
} from '../utils/storage-layout';
import { vacuumDatabase } from '../utils/vacuum-database';

/**
 * A folder named after a run or card is left alone this long after it last
 * changed: a chat being created can write its files a moment before its row.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

/** better-sqlite3's `pragma`, which `getNativeClient()` hands back untyped. */
interface SqlitePragmas {
  pragma(source: string, options: { simple: true }): unknown;
}

export interface StorageServiceOptions {
  /** The data folder (test seam); default `<userData>`. */
  root?: string;
  /** The database file (test seam); default `<userData>/geniro.db`. */
  databaseFile?: string;
  /** The open log file (test seam); default the debug sink's. */
  openLogFile?: () => string | null;
  /** Compacts the database (test seam). */
  vacuum?: (file: string) => Promise<void>;
  /** Free bytes on the data folder's disk (test seam). */
  freeDiskBytes?: (path: string) => Promise<number>;
  now?: () => number;
}

interface Doomed {
  path: string;
  bytes: number;
}

/**
 * What geniro keeps under its data folder, measured, and the clean-ups
 * Settings → Storage offers. One clean-up runs at a time, in the background:
 * deleting hundreds of archived chats or compacting a large database outlasts
 * any request, so the page reads its progress from {@link job}.
 *
 * Every path it deletes is built from the data folder and a name it listed
 * there itself — no route hands it a path.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;
  private readonly databaseFile: string;
  private readonly openLogFile: () => string | null;
  private readonly vacuum: (file: string) => Promise<void>;
  private readonly freeDiskBytes: (path: string) => Promise<number>;
  private readonly now: () => number;
  private current: StorageJob | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly chats: ChatService,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
    options: StorageServiceOptions = {},
  ) {
    this.root = options.root ?? environment.userDataDir;
    this.databaseFile = options.databaseFile ?? environment.dbPath;
    this.openLogFile = options.openLogFile ?? (() => debugSink.filePath());
    this.vacuum = options.vacuum ?? ((file) => vacuumDatabase(file));
    this.freeDiskBytes =
      options.freeDiskBytes ??
      (async (path) => {
        const info = await statfs(path);
        return info.bavail * info.bsize;
      });
    this.now = options.now ?? Date.now;
  }

  /** The clean-up running now, or the last one to finish, or null. */
  job(): StorageJob | null {
    return this.current;
  }

  async usage(): Promise<StorageUsage> {
    const classify = this.classifier();
    const seen = newSeenInodes();
    const groups = new Map<StorageGroupId, StorageGroup>();
    const add = (id: StorageGroupId, entry: StorageEntry): void => {
      const group = groups.get(id) ?? { id, bytes: 0, entries: [], clean: [] };
      group.bytes += entry.bytes;
      group.entries.push(entry);
      groups.set(id, group);
    };
    const unclaimed: string[] = [];
    for (const name of await listNames(this.root)) {
      const id = classify(name);
      if (id === null) {
        unclaimed.push(name);
        continue;
      }
      if (name === TEAMS_DIR_NAME) {
        add('teamBackups', {
          name: `${TEAMS_DIR_NAME}/${TEAM_BACKUP_DIR}`,
          bytes: await measurePath(this.backupsDir(), seen),
        });
      }
      add(id, { name, bytes: await measurePath(join(this.root, name), seen) });
    }

    const chats = await this.runDao.countByShelf(this.em.fork());
    const cleanups: Partial<Record<StorageGroupId, StorageCleanOption[]>> = {
      database: [
        ...(chats.archived > 0
          ? [
              {
                target: 'archivedChats' as const,
                count: chats.archived,
                bytes: null,
              },
            ]
          : []),
        ...(await this.compactable()),
      ],
      chatFiles: optionOf('orphanChatFiles', await this.orphanChatFiles()),
      taskFiles: optionOf('orphanTaskFiles', await this.orphanTaskFiles()),
      teamBackups: optionOf('teamBackups', await this.backupFiles()),
      logs: optionOf('logs', await this.closedLogs()),
      leftovers: optionOf('leftovers', await this.named(classify, 'leftovers')),
      settingsCopies: optionOf(
        'settingsCopies',
        await this.named(classify, 'settingsCopies'),
      ),
    };
    for (const [id, options] of Object.entries(cleanups)) {
      const group = groups.get(id as StorageGroupId);
      if (group !== undefined) {
        group.clean = options;
      }
    }

    return {
      root: this.root,
      scannedAt: new Date(this.now()).toISOString(),
      groups: STORAGE_GROUP_IDS.flatMap((id) => {
        const group = groups.get(id);
        return group === undefined ? [] : [group];
      }),
      chats,
      unclaimed,
      job: this.current,
    };
  }

  /**
   * Start one clean-up and answer at once; its outcome is read from
   * {@link job}. Refused while another runs.
   *
   * A compaction is only SCHEDULED here, for the next daemon start
   * ({@link compactIfScheduled}): it holds the database's write lock for its
   * whole length, and every write of a running daemon — a turn's, a monitor's,
   * a card's — gives up after better-sqlite3's 5 s busy timeout. The page
   * restarts the daemon next, which ends every agent process, so it is refused
   * while any agent works, in a turn or between them. Nothing else starts while
   * one is scheduled: the restart would cut it off.
   */
  async start(target: StorageCleanTarget): Promise<StorageJob> {
    if (
      this.current?.state === 'running' ||
      this.current?.state === 'scheduled'
    ) {
      throw new ConflictException(
        'STORAGE_BUSY',
        this.current.state === 'running'
          ? 'another clean-up is still running'
          : 'a compaction is scheduled for the next start',
      );
    }
    if (
      target === 'compactDatabase' &&
      (this.registry.activeCount > 0 || this.sessions.workingOffTurn > 0)
    ) {
      throw new ConflictException(
        'STORAGE_AGENTS_WORKING',
        'an agent, or a command or monitor it started, is still running — compact the database once every chat is idle',
      );
    }
    if (target === 'compactDatabase') {
      const room = await this.roomToCompact();
      if (room !== null) {
        throw new ConflictException('STORAGE_NO_ROOM', room);
      }
    }
    const job: StorageJob = {
      target,
      state: target === 'compactDatabase' ? 'scheduled' : 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      removed: 0,
      freedBytes: null,
      error: null,
    };
    this.current = job;
    if (target === 'compactDatabase') {
      await writeFile(this.markerFile(), new Date(this.now()).toISOString());
    } else {
      void this.run(job);
    }
    return job;
  }

  /**
   * Run the compaction the user scheduled, if any — called at boot, before
   * listen, so nothing else writes meanwhile. The marker is removed first, so
   * a compaction that crashes the daemon is not retried on every start.
   */
  async compactIfScheduled(): Promise<void> {
    if (!existsSync(this.markerFile())) {
      return;
    }
    await rm(this.markerFile(), { force: true });
    const job: StorageJob = {
      target: 'compactDatabase',
      state: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      removed: 0,
      freedBytes: null,
      error: null,
    };
    this.current = job;
    const room = await this.roomToCompact();
    if (room !== null) {
      job.state = 'failed';
      job.error = room;
      job.finishedAt = new Date(this.now()).toISOString();
      this.logger.warn(`skipped the scheduled compaction: ${room}`);
      return;
    }
    await this.run(job);
  }

  /**
   * Why the disk cannot hold a compaction, or null when it can. A VACUUM
   * writes a copy of the live data and then the same pages to the WAL, so it
   * needs about twice the database's size free; the file's own size bounds
   * the live data from above.
   */
  private async roomToCompact(): Promise<string | null> {
    const needed = 2 * (await this.databaseBytes());
    const free = await this.freeDiskBytes(this.root).catch(() => null);
    if (free === null || free >= needed) {
      return null;
    }
    return `compacting needs about ${Math.ceil(needed / 1024 ** 2)} MB free on the disk and ${Math.floor(free / 1024 ** 2)} MB is — free some first, for instance by removing finished task worktrees`;
  }

  private markerFile(): string {
    return join(this.root, COMPACTION_MARKER_FILE);
  }

  private async run(job: StorageJob): Promise<void> {
    try {
      const outcome = await this.perform(job.target);
      job.removed = outcome.removed;
      job.freedBytes = outcome.freedBytes;
      job.state = 'done';
      this.logger.log(
        `storage clean-up ${job.target}: removed ${outcome.removed}, freed ${outcome.freedBytes ?? 'unknown'} bytes`,
      );
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      this.logger.warn(`storage clean-up ${job.target} failed: ${job.error}`);
    } finally {
      job.finishedAt = new Date(this.now()).toISOString();
    }
  }

  private async perform(
    target: StorageCleanTarget,
  ): Promise<{ removed: number; freedBytes: number | null }> {
    switch (target) {
      case 'archivedChats': {
        const { deleted } = await this.chats.sweepArchived(0);
        return { removed: deleted, freedBytes: null };
      }
      case 'compactDatabase': {
        const before = await this.databaseBytes();
        await this.vacuum(this.databaseFile);
        const after = await this.databaseBytes();
        return { removed: 0, freedBytes: Math.max(0, before - after) };
      }
      case 'orphanChatFiles':
        return removeAll(await this.orphanChatFiles());
      case 'orphanTaskFiles':
        return removeAll(await this.orphanTaskFiles());
      case 'teamBackups':
        return removeAll(await this.backupFiles());
      case 'logs':
        return removeAll(await this.closedLogs());
      case 'leftovers':
      case 'settingsCopies':
        return removeAll(await this.named(this.classifier(), target));
    }
  }

  private classifier(): StorageClassifier {
    return storageClassifier(
      [...this.adapters.all().values()].map((adapter) => adapter.getConfig()),
    );
  }

  private async compactable(): Promise<StorageCleanOption[]> {
    const free = await this.freeBytes();
    return free > 0
      ? [{ target: 'compactDatabase', count: 0, bytes: free }]
      : [];
  }

  /** Space the file holds on its free list — what a compaction gives back. */
  private async freeBytes(): Promise<number> {
    try {
      const database = (await this.em
        .getConnection()
        .getNativeClient()) as SqlitePragmas;
      const pages = Number(database.pragma('freelist_count', { simple: true }));
      const size = Number(database.pragma('page_size', { simple: true }));
      return Number.isFinite(pages * size) ? pages * size : 0;
    } catch (error) {
      this.logger.warn(
        `could not read the database's free space: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  private async databaseBytes(): Promise<number> {
    let total = 0;
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      total += await measurePath(`${this.databaseFile}${suffix}`);
    }
    return total;
  }

  private backupsDir(): string {
    return join(this.root, TEAMS_DIR_NAME, TEAM_BACKUP_DIR);
  }

  private async backupFiles(): Promise<Doomed[]> {
    return this.measured(
      (await listNames(this.backupsDir())).map((name) =>
        join(this.backupsDir(), name),
      ),
    );
  }

  /** Every log file but the one the daemon is writing now. */
  private async closedLogs(): Promise<Doomed[]> {
    const open = this.openLogFile();
    const dir = join(this.root, DEBUG_LOG_DIR_NAME);
    return this.measured(
      (await listNames(dir))
        .filter((name) => open === null || name !== basename(open))
        .map((name) => join(dir, name)),
    );
  }

  private async named(
    classify: StorageClassifier,
    group: StorageGroupId,
  ): Promise<Doomed[]> {
    return this.measured(
      (await listNames(this.root))
        .filter((name) => classify(name) === group)
        .map((name) => join(this.root, name)),
    );
  }

  /** Folders of chats that no longer exist, deleted ones' rows included. */
  private async orphanChatFiles(): Promise<Doomed[]> {
    const runs = await this.runDao.allIdsIncludingDeleted(this.em.fork());
    const paths: string[] = [];
    for (const dir of RUN_FILE_DIRS) {
      paths.push(...(await this.staleUnknown(join(this.root, dir), runs)));
    }
    return this.measured(paths);
  }

  /** Folders of cards that no longer exist, deleted ones' rows included. */
  private async orphanTaskFiles(): Promise<Doomed[]> {
    const tasks = await this.taskDao.allIdsIncludingDeleted(this.em.fork());
    return this.measured(
      await this.staleUnknown(
        join(this.root, TASK_ATTACHMENTS_DIR_NAME),
        tasks,
      ),
    );
  }

  private async staleUnknown(
    dir: string,
    known: ReadonlySet<string>,
  ): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || known.has(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      if (info !== null && this.now() - info.mtimeMs >= ORPHAN_MIN_AGE_MS) {
        out.push(path);
      }
    }
    return out;
  }

  private async measured(paths: readonly string[]): Promise<Doomed[]> {
    const seen: SeenInodes = newSeenInodes();
    const out: Doomed[] = [];
    for (const path of paths) {
      out.push({ path, bytes: await measurePath(path, seen) });
    }
    return out;
  }
}

function optionOf(
  target: StorageCleanTarget,
  doomed: readonly Doomed[],
): StorageCleanOption[] {
  return doomed.length === 0
    ? []
    : [
        {
          target,
          count: doomed.length,
          bytes: doomed.reduce((sum, item) => sum + item.bytes, 0),
        },
      ];
}

async function removeAll(
  doomed: readonly Doomed[],
): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  for (const item of doomed) {
    await rm(item.path, { recursive: true, force: true });
    removed += 1;
    freedBytes += item.bytes;
  }
  return { removed, freedBytes };
}
