import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import {
  cleanStrandedMerge,
  type CleanupOutcome,
  readMergeJournal,
  writeMergeJournal,
} from '../utils/cursor-mcp-cleanup';

/** Why a cwd was left alone, in words the user can act on. */
const REASONS: Record<Exclude<CleanupOutcome, 'cleaned'>, string> = {
  foreign:
    'its `geniro` MCP entry is not one we wrote, so it is yours and we left it alone',
  unresolved:
    'we could not safely read it (a symlink, or JSON we will not guess at)',
  failed: 'cleanup kept failing there',
};

/**
 * How many launches a failing cwd earns before we give up on it.
 *
 * Counted, not timed. The journal's `ts` records when the DELETED transport
 * merged — often long before this code shipped — so ageing from it would spend
 * the whole window before the first attempt and give the oldest residue zero
 * retries. A counter measures what we actually care about (how many times we
 * have tried) and needs no clock, so a wrong or future-dated stamp cannot buy
 * unlimited retries either. The journal has to reach empty for the "delete one
 * release after shipping" promise to be honourable.
 */
const MAX_ATTEMPTS = 3;

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
   * Clean up whatever the deleted transport stranded, and never do worse than
   * nothing. This runs pre-listen, so an escaping error would exit the process
   * before the pidfile is written and repeat on every launch — a read-only or
   * full userData dir must not cost the user their daemon over a one-release
   * hygiene task. Returns how many cwds were cleaned.
   */
  reconcileStranded(): number {
    try {
      return this.replayJournal();
    } catch (err) {
      this.logger.warn(
        `cursor MCP cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Replay the journal. A cwd is retried on a later launch only while cleanup
   * reports `failed` and it has been tried fewer than `MAX_ATTEMPTS` times;
   * every other conclusion is reported once and dropped, so the journal
   * converges to empty and this module stays deletable. Returns how many cwds
   * were actually cleaned.
   */
  private replayJournal(): number {
    const entries = readMergeJournal(this.journalPath);
    if (entries.length === 0) {
      return 0;
    }
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
      const attempts = (entry.attempts ?? 0) + 1;
      if (outcome === 'failed' && attempts < MAX_ATTEMPTS) {
        retry.push({ ...entry, attempts });
        continue;
      }
      this.reportResidue(entry.cwd, outcome);
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

  /**
   * Name residue we are giving up on. This is the user's ONLY signal that a
   * file in their own repository still needs attention — and `.geniro-bak` is
   * a byte copy of their pre-merge `.cursor/mcp.json`, which routinely carries
   * other servers' API keys and sits at a path a `.gitignore` entry for
   * `.cursor/mcp.json` does not match. Say so plainly; nothing revisits it.
   */
  private reportResidue(
    cwd: string,
    outcome: Exclude<CleanupOutcome, 'cleaned'>,
  ): void {
    this.logger.warn(
      `left the cursor MCP residue in ${cwd} for you to resolve — ${REASONS[outcome]}. ` +
        `${join(cwd, '.cursor', 'mcp.json.geniro-bak')} is a copy of your own .cursor/mcp.json: ` +
        `it may contain credentials, so review it before committing and delete it once you are done. ` +
        `Nothing in geniro will touch these files again.`,
    );
  }
}
