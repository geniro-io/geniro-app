import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import {
  cleanStrandedMerge,
  readMergeJournal,
  writeMergeJournal as writeJournal,
} from '../utils/cursor-mcp-cleanup';

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
    const entries = readMergeJournal(this.journalPath);
    if (entries.length === 0) {
      return 0;
    }
    const unfinished = entries.filter((entry) => {
      if (cleanStrandedMerge(entry.cwd, entry)) {
        return false;
      }
      this.logger.warn(
        `could not clean the stranded .cursor/mcp.json merge in ${entry.cwd} — keeping its journal entry to retry on the next launch`,
      );
      return true;
    });
    const cleaned = entries.length - unfinished.length;
    if (unfinished.length === 0) {
      rmSync(this.journalPath, { force: true });
    } else {
      writeJournal(this.journalPath, unfinished);
    }
    if (cleaned > 0) {
      this.logger.log(
        `cleaned ${cleaned} .cursor/mcp.json merge(s) left by the removed cursor-agent transport`,
      );
    }
    return cleaned;
  }
}
