import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import {
  cleanStrandedMerge,
  readMergeJournal,
  writeMergeJournal,
} from '../utils/cursor-mcp-cleanup';

/**
 * How long a transient failure keeps earning another launch. Past this the
 * entry is reported and dropped: the journal has to reach empty for the
 * "delete one release after shipping" promise to be honourable.
 */
const GIVE_UP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface CursorMcpCleanupOptions {
  /** Test seam — the journal file the deleted transport wrote. */
  journalPath?: string;
}

/**
 * One-release boot cleanup for `.cursor/mcp.json` merges stranded in USER
 * worktrees by the deleted legacy cursor transport. See
 * `utils/cursor-mcp-cleanup.ts` for what that residue is and why removing it
 * is an obligation rather than hygiene — the file belongs to the user, and
 * nothing else in the daemon will ever touch it again.
 *
 * Delete this service, its util, and the `main.ts` call one release after
 * shipping: by then every upgrading install has booted at least once.
 */
@Injectable()
export class CursorMcpCleanupService {
  private readonly logger = new Logger(CursorMcpCleanupService.name);
  private readonly journalPath: string;

  constructor(options: CursorMcpCleanupOptions = {}) {
    this.journalPath =
      options.journalPath ??
      join(environment.userDataDir, 'cursor-mcp-journal.json');
  }

  /**
   * Replay the journal, cleaning each cwd it names. The journal is removed
   * only when every entry cleaned — a cwd we could not finish keeps its entry
   * so the next launch tries again. Returns how many were cleaned.
   */
  reconcileStranded(): number {
    try {
      return this.replayJournal();
    } catch (err) {
      // Boot-critical: this runs pre-listen, so an escaping error would exit
      // the process before the pidfile is written and repeat on every launch.
      // A read-only or full userData dir must not cost the user their daemon
      // over a one-release hygiene task.
      this.logger.warn(
        `cursor MCP cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private replayJournal(): number {
    const entries = readMergeJournal(this.journalPath);
    if (entries.length === 0) {
      return 0;
    }
    const now = Date.now();
    const retry: typeof entries = [];
    let cleaned = 0;
    for (const entry of entries) {
      const outcome = cleanStrandedMerge(entry.cwd, entry);
      if (outcome === 'cleaned') {
        // Counted separately from "not retried": a file we deliberately left
        // alone is not one we cleaned, and reporting it as such would claim
        // work that did not happen.
        cleaned += 1;
        continue;
      }
      if (outcome === 'retry' && now - entry.ts < GIVE_UP_AFTER_MS) {
        retry.push(entry);
        continue;
      }
      // Everything else is a decision not to touch the file — a foreign
      // `geniro` key, a symlink, content we will not guess at — or a retry
      // that has run out of road. Name the residue once and drop the entry,
      // so the journal converges and this module stays deletable.
      this.logger.warn(
        `leaving the .cursor/mcp.json residue in ${entry.cwd} for you to resolve (${outcome}) — look for a .geniro-bak sibling; nothing else will touch this file`,
      );
    }
    if (retry.length === 0) {
      rmSync(this.journalPath, { force: true });
    } else {
      writeMergeJournal(this.journalPath, retry);
    }
    if (cleaned > 0) {
      this.logger.log(
        `cleaned ${cleaned} .cursor/mcp.json merge(s) left by the removed cursor-agent transport`,
      );
    }
    return cleaned;
  }
}
