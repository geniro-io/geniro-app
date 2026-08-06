import { Injectable, Logger } from '@nestjs/common';

import {
  isSameProcess,
  readProcessStartTimes,
  type StartTimeProbe,
} from '../../../utils/process-identity';
import {
  clearChildJournal,
  type JournaledChild,
  readChildJournal,
} from '../utils/child-journal';
import { killProcessGroup } from '../utils/kill-tree';

/** Test seams — the production factory passes nothing. */
export interface StrandedChildReaperOptions {
  startTimes?: StartTimeProbe;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  logger?: { log(msg: string): void; warn(msg: string): void };
}

/**
 * Kill the process groups a previous daemon launch left running.
 *
 * The counterpart to the child journal, and the ONLY mechanism that survives a
 * SIGKILL: `ProcessRegistry.onApplicationShutdown` reaps on the graceful path,
 * and there is no graceful path when the UI supervisor escalates past its
 * shutdown grace or the machine kills the daemon outright. What is left behind
 * is a detached, reparented process group that never exits on its own —
 * measured here as `cursor-agent acp` groups 14 hours old at 217 MB each.
 *
 * Runs at boot, before the server listens, so a stray from the previous launch
 * cannot still be holding a session file while the new launch resumes it.
 *
 * It never kills on a pid alone. A pid recorded hours ago may belong to
 * anything by now — including the user's own interactive `claude` — so each
 * entry is confirmed against the kernel's start time for that pid before it is
 * signalled ({@link isSameProcess}). An entry that cannot be confirmed is left
 * alone, which is the right way to be wrong: a surviving stray costs memory, a
 * mistaken SIGKILL costs the user's work.
 */
@Injectable()
export class StrandedChildReaper {
  private readonly logger: NonNullable<StrandedChildReaperOptions['logger']>;
  private readonly startTimes: StartTimeProbe;
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    private readonly journalPath: string,
    options: StrandedChildReaperOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(StrandedChildReaper.name);
    this.startTimes = options.startTimes ?? readProcessStartTimes;
    this.killGroup =
      options.killGroup ??
      ((pid, signal) =>
        killProcessGroup(pid, signal, () => process.kill(pid, signal)));
    this.isAlive =
      options.isAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
  }

  /**
   * Reap, and clear the journal. Returns the groups actually signalled, so the
   * boot log can say what it did rather than that it ran.
   */
  reap(): JournaledChild[] {
    const journal = readChildJournal(this.journalPath, this.logger);
    if (!journal) {
      return [];
    }
    // A journal whose author is still running describes ANOTHER daemon's live
    // children, not strays. The instance lock should make this unreachable;
    // if it ever becomes reachable, the wrong move is to kill them.
    if (journal.ownerPid !== process.pid && this.isAlive(journal.ownerPid)) {
      this.logger.warn(
        `child journal at ${this.journalPath} belongs to daemon pid ${journal.ownerPid}, which is still running — leaving its ${journal.children.length} child group(s) alone`,
      );
      return [];
    }
    if (journal.children.length === 0) {
      clearChildJournal(this.journalPath);
      return [];
    }

    const startTimes = this.startTimes(journal.children.map((c) => c.pid));
    const stranded = journal.children.filter((child) =>
      isSameProcess(child.pid, child.startedAt, startTimes),
    );
    for (const child of stranded) {
      // SIGKILL, not SIGTERM: these groups are already proven not to exit on
      // their own — an abandoned `cursor-agent acp` sits blocked on a stdin
      // that no longer has a writer, and a SIGTERM grace period here would
      // only delay the boot for a process that is not listening for it.
      this.killGroup(child.pid, 'SIGKILL');
      this.logger.log(
        `reaped stranded process group ${child.pid} (${child.command}) left by a previous daemon launch`,
      );
    }
    const skipped = journal.children.length - stranded.length;
    if (skipped > 0) {
      // Almost always "it already exited" — but it also covers "that pid is
      // now someone else's", which is why they are counted, not asserted about.
      this.logger.log(
        `${skipped} journaled child group(s) were gone or could not be confirmed — left alone`,
      );
    }
    clearChildJournal(this.journalPath);
    return stranded;
  }
}
