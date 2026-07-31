import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../../environments';
import { ProcessRegistry } from '../../services/process-registry';
import { buildChildEnv } from '../../utils/child-env';
import { childProcessHandle } from '../../utils/child-handle';
import { KeyedMutex } from '../../utils/keyed-mutex';
import {
  CURSOR_MCP_CONFIG_SEGMENTS,
  CURSOR_MCP_GIT_CHECK_TIMEOUT_MS,
  CURSOR_MCP_GIT_COMMAND,
  CURSOR_MCP_JOURNAL_FILE,
  CURSOR_MCP_LOCK_WAIT_MS,
  cursorMcpGitTrackedArgs,
} from './cursor.const';
import type {
  CursorMcpAcquireResult,
  CursorMcpMergeOptions,
  CursorMcpMergeState,
} from './cursor.types';
import { enableGeniroMcpServer } from './utils/cursor-mcp-enable.utils';
import { buildCursorMcpServerEntry } from './utils/cursor-mcp-entry.utils';
import {
  mergeGeniroEntry,
  restoreGeniroEntry,
} from './utils/cursor-mcp-file.utils';
import {
  addJournalEntry,
  readJournal,
  removeJournalEntry,
} from './utils/cursor-mcp-journal.utils';

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
  private readonly restoreEntry: (
    cwd: string,
    state: CursorMcpMergeState,
  ) => boolean;

  constructor(
    private readonly processes: ProcessRegistry,
    options: CursorMcpMergeOptions = {},
  ) {
    this.journalPath =
      options.journalPath ??
      join(environment.userDataDir, CURSOR_MCP_JOURNAL_FILE);
    this.lockWaitMs = options.lockWaitMs ?? CURSOR_MCP_LOCK_WAIT_MS;
    this.execFileFn = options.execFileFn ?? execFile;
    this.restoreEntry = options.restoreFn ?? restoreGeniroEntry;
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
    const stranded = readJournal(this.journalPath).find(
      (entry) => entry.cwd === cwd,
    );
    if (stranded) {
      if (
        !this.restoreEntry(cwd, {
          created: stranded.created,
          mode: stranded.mode,
        })
      ) {
        releaseLock();
        return {
          ok: false,
          reason: `a previous cursor MCP merge in ${cwd} still needs recovery`,
        };
      }
      try {
        removeJournalEntry(this.journalPath, cwd);
      } catch (err) {
        releaseLock();
        return {
          ok: false,
          reason: `recovered a previous cursor MCP merge but could not clear its journal: ${String(err)}`,
        };
      }
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
    let mergeAttempted = false;
    let merged: ReturnType<typeof mergeGeniroEntry>;
    try {
      const configPath = join(cwd, ...CURSOR_MCP_CONFIG_SEGMENTS);
      created = !existsSync(configPath);
      mode = created ? undefined : statSync(configPath).mode & 0o777;
      const entry = buildCursorMcpServerEntry(endpoint);
      // Journal BEFORE the file is touched — a crash between the two leaves a
      // harmless entry whose restore is a no-op.
      addJournalEntry(this.journalPath, {
        cwd,
        created,
        mode,
        ts: Date.now(),
      });
      mergeAttempted = true;
      merged = mergeGeniroEntry(cwd, entry);
    } catch (err) {
      try {
        // Undo whatever landed (a mid-merge throw leaves at most a stray
        // backup — restore never throws and no-ops when nothing merged)
        // BEFORE dropping the journal entry, or the boot reconcile loses its
        // only pointer to a half-done merge.
        if (mergeAttempted && this.restoreEntry(cwd, { created, mode })) {
          removeJournalEntry(this.journalPath, cwd);
        }
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
    const state = {
      created: merged.created,
      mode: merged.mode,
    };
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
          if (this.restoreEntry(cwd, state)) {
            removeJournalEntry(this.journalPath, cwd);
          } else {
            this.logger.warn(
              `could not restore .cursor/mcp.json in ${cwd} — retained crash journal entry for retry`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `could not finalize .cursor/mcp.json restore in ${cwd}: ${String(err)}`,
          );
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
    let restored = 0;
    for (const entry of entries) {
      if (
        !this.restoreEntry(entry.cwd, {
          created: entry.created,
          mode: entry.mode,
        })
      ) {
        this.logger.warn(
          `could not restore stranded .cursor/mcp.json merge in ${entry.cwd} — retained journal entry`,
        );
        continue;
      }
      try {
        removeJournalEntry(this.journalPath, entry.cwd);
        restored += 1;
        this.logger.warn(
          `restored a stranded .cursor/mcp.json merge in ${entry.cwd}`,
        );
      } catch (err) {
        this.logger.warn(
          `restored .cursor/mcp.json in ${entry.cwd} but could not clear its journal entry: ${String(err)}`,
        );
      }
    }
    return restored;
  }

  /** True when `.cursor/mcp.json` is tracked by git in `cwd`'s repo. */
  private isGitTracked(cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = this.execFileFn(
        CURSOR_MCP_GIT_COMMAND,
        cursorMcpGitTrackedArgs(cwd),
        {
          timeout: CURSOR_MCP_GIT_CHECK_TIMEOUT_MS,
          encoding: 'utf8',
          env: buildChildEnv(),
        },
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
