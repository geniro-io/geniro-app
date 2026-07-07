import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import { childProcessHandle } from '../utils/child-handle';
import { enableGeniroMcpServer } from '../utils/cursor-mcp-enable';
import { buildCursorMcpServerEntry } from '../utils/cursor-mcp-entry';
import { mergeGeniroEntry, restoreGeniroEntry } from '../utils/cursor-mcp-file';
import {
  addJournalEntry,
  readJournal,
  removeJournalEntry,
} from '../utils/cursor-mcp-journal';
import { KeyedMutex } from '../utils/keyed-mutex';
import { ProcessRegistry } from './process-registry';

/**
 * Lock wait before a caller turn degrades. Long enough for a quick prior turn
 * to clear the cwd, short enough that a caller-chain deadlock (a lock-holding
 * cursor caller synchronously awaiting a callee that needs the same cwd's
 * lock) breaks into a visible degrade instead of hanging the run.
 */
const LOCK_WAIT_MS = 30_000;

const GIT_CHECK_TIMEOUT_MS = 5_000;

export interface CursorMcpMergeOptions {
  /** Crash journal (test seam); default `<userData>/cursor-mcp-journal.json`. */
  journalPath?: string;
  lockWaitMs?: number;
  /** Replacement execFile for tests (`mcp enable` + git children). */
  execFileFn?: typeof execFile;
}

export type CursorMcpAcquireResult =
  | {
      ok: true;
      /** `.cursor/mcp.json` is git-tracked — surface the commit warning. */
      gitTracked: boolean;
      /** Restore the file, clear the journal, free the cwd. Idempotent. */
      release: () => void;
    }
  | { ok: false; reason: string };

/**
 * The `.cursor/mcp.json` merge lifecycle around one cursor caller turn (M3
 * step-2) — the executor acquires BEFORE spawning the turn and releases when
 * it settles. Lives here (not in CursorAdapter.prepareTurn) because acquiring
 * is asynchronous — the per-cwd lock may wait — while prepareTurn is a
 * synchronous hook; and because a refused merge must DEGRADE the turn (run
 * without call tools + a visible system item the executor persists), never
 * fail it.
 *
 * Order of operations is load-bearing: lock → journal entry → file merge, so
 * a crash at any point leaves either nothing or a journaled merge the boot
 * reconcile ({@link reconcileStranded}) undoes.
 */
@Injectable()
export class CursorMcpMergeService {
  private readonly logger = new Logger(CursorMcpMergeService.name);
  private readonly mutex = new KeyedMutex();
  private readonly journalPath: string;
  private readonly lockWaitMs: number;
  private readonly execFileFn: typeof execFile;

  constructor(
    private readonly processes: ProcessRegistry,
    options: CursorMcpMergeOptions = {},
  ) {
    this.journalPath =
      options.journalPath ??
      join(environment.userDataDir, 'cursor-mcp-journal.json');
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.execFileFn = options.execFileFn ?? execFile;
  }

  /** Merge the geniro entry for one turn; the result's release undoes it. */
  async acquire(
    cwd: string,
    endpoint: { url: string; token: string },
  ): Promise<CursorMcpAcquireResult> {
    const releaseLock = await this.mutex.acquire(cwd, this.lockWaitMs);
    if (!releaseLock) {
      return {
        ok: false,
        reason: `another cursor caller is holding ${cwd}/.cursor/mcp.json — gave up after ${Math.round(this.lockWaitMs / 1000)}s`,
      };
    }
    // Every path out of this section MUST free the lock: journal and merge
    // writes throw on real filesystems (EROFS, EACCES, ENOSPC, `.cursor`
    // being a file), and a throw escaping with the lock held would degrade
    // this cwd for the rest of the daemon launch. `created`/`mode` are read
    // BEFORE anything is written (race-free under the lock), so the one
    // journal entry is complete up front and the catch can undo a partial
    // merge with the same state.
    let created = false;
    let mode: number | undefined;
    let merged: ReturnType<typeof mergeGeniroEntry>;
    try {
      const configPath = join(cwd, '.cursor', 'mcp.json');
      created = !existsSync(configPath);
      mode = created ? undefined : statSync(configPath).mode & 0o777;
      // Journal BEFORE the file is touched — a crash between the two leaves a
      // harmless entry whose restore is a no-op.
      addJournalEntry(this.journalPath, { cwd, created, mode, ts: Date.now() });
      merged = mergeGeniroEntry(cwd, buildCursorMcpServerEntry(endpoint));
    } catch (err) {
      try {
        // Undo whatever landed (a mid-merge throw leaves at most a stray
        // backup — restore never throws and no-ops when nothing merged)
        // BEFORE dropping the journal entry, or the boot reconcile loses its
        // only pointer to a half-done merge.
        restoreGeniroEntry(cwd, { created, mode });
        removeJournalEntry(this.journalPath, cwd);
      } catch {
        // The stranded entry is harmless — restore is a no-op without our key.
      }
      releaseLock();
      return {
        ok: false,
        reason: `.cursor/mcp.json merge failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!merged.ok) {
      try {
        removeJournalEntry(this.journalPath, cwd);
      } finally {
        releaseLock();
      }
      return { ok: false, reason: merged.reason };
    }
    const state = { created: merged.created, mode: merged.mode };
    await enableGeniroMcpServer(cwd, {
      execFileFn: this.execFileFn,
      onSpawn: (child) =>
        this.processes.register(
          `cursor-mcp:enable:${randomUUID()}`,
          childProcessHandle(child),
        ),
    });
    const gitTracked = await this.isGitTracked(cwd);

    let released = false;
    return {
      ok: true,
      gitTracked,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          restoreGeniroEntry(cwd, state);
          removeJournalEntry(this.journalPath, cwd);
        } catch {
          // Journal removal failed — the boot reconcile re-runs the restore,
          // which is idempotent once our key is gone.
        } finally {
          releaseLock();
        }
      },
    };
  }

  /**
   * Boot reconcile (M3 step-3): undo every merge a crash / SIGKILL stranded.
   * Best-effort and synchronous-ish — it must never block or fail the boot.
   */
  reconcileStranded(): number {
    const entries = readJournal(this.journalPath);
    for (const entry of entries) {
      restoreGeniroEntry(entry.cwd, {
        created: entry.created,
        mode: entry.mode,
      });
      removeJournalEntry(this.journalPath, entry.cwd);
      this.logger.warn(
        `restored a stranded .cursor/mcp.json merge in ${entry.cwd}`,
      );
    }
    return entries.length;
  }

  /** True when `.cursor/mcp.json` is tracked by git in `cwd`'s repo. */
  private isGitTracked(cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = this.execFileFn(
        'git',
        ['-C', cwd, 'ls-files', '--error-unmatch', '.cursor/mcp.json'],
        { timeout: GIT_CHECK_TIMEOUT_MS, encoding: 'utf8' },
        (err) => {
          if (err === null) {
            resolve(true);
            return;
          }
          // Exit 1 = genuinely untracked / not a repo. Anything else (git
          // missing, timeout kill) is a check FAILURE — don't claim untracked
          // silently for a token-bearing file.
          const code = (err as { code?: unknown }).code;
          if (code !== 1) {
            this.logger.warn(
              `git-tracked check failed in ${cwd} (${String(code ?? err)}) — proceeding as untracked`,
            );
          }
          resolve(false);
        },
      );
      this.processes.register(
        `cursor-mcp:git-check:${randomUUID()}`,
        childProcessHandle(child),
      );
    });
  }
}
