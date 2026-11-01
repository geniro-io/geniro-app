import { realpath } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { namedPathForms, namesForm } from '../utils/named-paths';
import { ItemSeqAllocator } from './item-seq.allocator';

/**
 * How many seqs one query covers. better-sqlite3 runs a statement on the event
 * loop, and a long thread's tool calls run to tens of megabytes, so a first
 * read is cut into windows with a yield between them.
 */
const SCAN_WINDOW_SEQS = 2000;

/** Runs whose reading is remembered; the oldest is forgotten past this. */
const MAX_REMEMBERED_RUNS = 256;

/** What has been read of one run, so a later ask reads only newer rows. */
interface RunReading {
  /** Every tool call through this seq has been checked for `checked`. */
  through: number;
  /** Candidates checked through `through`, and whether the run names them. */
  checked: Map<string, boolean>;
}

/**
 * Which of a set of folders this run's own tool calls name.
 *
 * The desktop app lists a repository's other working trees (the daemon runs no
 * git), and this narrows them to the ones the thread worked in. A repository's
 * worktrees belong to every thread and session that ever made one — two
 * teams on one repo each make their own — so the thread's transcript is
 * the one record that says which are its.
 *
 * Asked on every turn end, so each run's reading is remembered: a later ask
 * reads only the tool calls written since, and the whole transcript only for a
 * candidate it has not seen. Memory only — a restart reads each run once more.
 */
@Injectable()
export class RunNamedPathsService {
  private readonly readings = new Map<string, RunReading>();

  /**
   * Per-run serialization: two asks for one run (the desktop window and a
   * paired phone at one turn end) read and write the same `RunReading` across
   * awaits, and interleaved they can record a named folder as not named.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly seqs: ItemSeqAllocator,
  ) {}

  named(runId: string, paths: readonly string[]): Promise<{ named: string[] }> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    // A stored link never rejects (see `link`), so `previous` cannot either.
    const next = previous.then(() => this.read(runId, paths));
    const link = next.catch(() => undefined);
    this.chains.set(runId, link);
    void link.then(() => {
      if (this.chains.get(runId) === link) {
        this.chains.delete(runId);
      }
    });
    return next;
  }

  private async read(
    runId: string,
    paths: readonly string[],
  ): Promise<{ named: string[] }> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    const folders = await runFolders(run.cwd);
    // The run's own folder, or one holding it, is named by every path the
    // thread touches inside its own folder — never evidence of working there.
    const candidates = [...new Set(paths)].filter(
      (path) =>
        !folders.some(
          (folder) => folder === path || folder.startsWith(`${path}/`),
        ),
    );
    const reading = this.readingOf(runId);
    // Clamped to what is fully written: a row's seq is reserved before it is
    // inserted, and a watermark past an unwritten one would never read it.
    const last = this.seqs.writtenThrough(
      runId,
      await this.itemDao.lastToolCallSeq(runId, em),
    );
    const unseen = candidates.filter((path) => !reading.checked.has(path));
    const open = candidates.filter(
      (path) => reading.checked.get(path) === false,
    );

    const found = new Set<string>();
    await this.scan(runId, unseen, folders, 0, reading.through, found, em);
    await this.scan(
      runId,
      [...unseen, ...open],
      folders,
      reading.through,
      last,
      found,
      em,
    );

    reading.through = Math.max(reading.through, last);
    for (const path of [...unseen, ...open]) {
      reading.checked.set(path, found.has(path));
    }
    return {
      named: candidates.filter((path) => reading.checked.get(path) === true),
    };
  }

  /** Mark in `found` each candidate a tool call in `(after, through]` names. */
  private async scan(
    runId: string,
    candidates: readonly string[],
    folders: readonly string[],
    after: number,
    through: number,
    found: Set<string>,
    em: EntityManager,
  ): Promise<void> {
    const forms = new Map(
      candidates.map((path) => [path, namedPathForms(path, folders)]),
    );
    for (let from = after; from < through; from += SCAN_WINDOW_SEQS) {
      const pending = [...forms].filter(([path]) => !found.has(path));
      if (pending.length === 0) {
        return;
      }
      const rows = await this.itemDao.toolCallsContainingAny(
        runId,
        from,
        Math.min(from + SCAN_WINDOW_SEQS, through),
        pending.flatMap(([, texts]) => texts),
        em,
      );
      for (const { payload } of rows) {
        for (const [path, texts] of pending) {
          if (texts.some((text) => namesForm(payload, text))) {
            found.add(path);
          }
        }
      }
      await yieldToEventLoop();
    }
  }

  private readingOf(runId: string): RunReading {
    const held = this.readings.get(runId);
    if (held !== undefined) {
      // To the back: what is forgotten past the cap is the run least recently
      // asked about, not the first one ever asked.
      this.readings.delete(runId);
      this.readings.set(runId, held);
      return held;
    }
    if (this.readings.size >= MAX_REMEMBERED_RUNS) {
      const oldest = this.readings.keys().next().value;
      if (oldest !== undefined) {
        this.readings.delete(oldest);
      }
    }
    const fresh: RunReading = { through: 0, checked: new Map() };
    this.readings.set(runId, fresh);
    return fresh;
  }
}

/**
 * The run's folder as stored and as resolved: git names worktrees by their
 * real path, while an agent's relative path is relative to the folder as given.
 */
async function runFolders(cwd: string | null): Promise<string[]> {
  if (cwd === null) {
    return [];
  }
  const resolved = await realpath(cwd).catch(() => cwd);
  return resolved === cwd ? [cwd] : [cwd, resolved];
}
