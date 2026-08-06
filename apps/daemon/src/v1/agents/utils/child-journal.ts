import { readFileSync, rmSync } from 'node:fs';

import { atomicWriteSync } from '../../../utils/atomic-file';

/**
 * The on-disk record of every process GROUP this daemon launch has spawned.
 *
 * `ProcessRegistry` already reaps children on the graceful path, and that is
 * the only path it can serve: it lives in memory. A SIGKILL — the UI
 * supervisor's escalation past its shutdown grace, a crash, a `kill -9` — skips
 * Nest's shutdown hooks entirely, and because every agent child is spawned
 * `detached` (a group leader, so cancel can reach its tool/MCP grandchildren)
 * the group is NOT in the daemon's own process group and does not die with it.
 * It is reparented to launchd and runs until the machine reboots.
 *
 * Measured on this machine before the journal existed: two `cursor-agent acp`
 * groups, ppid 1, 14 hours old, 217 MB resident each, blocked forever on a
 * stdin nobody would ever write to again. Nothing in the daemon knew they
 * existed — which is the actual gap. Killing them needs no cleverness, only a
 * record that outlives the process that made it.
 *
 * So: write the group down when it is spawned, erase it when it exits, and
 * sweep whatever the file still holds at the next boot
 * ({@link StrandedChildReaper}). The file is authoritative only about groups
 * this daemon started; identity is re-verified against the kernel before
 * anything is signalled (see `utils/process-identity`).
 */

/** Journal file name under the userData dir. */
export const CHILD_JOURNAL_FILE_NAME = 'children.json';

/** One spawned process group, as recorded at spawn time. */
export interface JournaledChild {
  /**
   * The child's pid, which doubles as its process-GROUP id — every spawn this
   * journal covers is `detached`, so the leader's pid names the whole group.
   */
  pid: number;
  /** `Date.now()` at the spawn, the identity check the reaper re-verifies. */
  startedAt: number;
  /** The binary, for the reap log — a stray should be nameable, not just a pid. */
  command: string;
}

/** The journal file's shape. */
export interface ChildJournalFile {
  version: 1;
  /**
   * The daemon that wrote this file.
   *
   * The reaper refuses to act on a journal whose owner is still alive: those
   * groups belong to a RUNNING daemon, and reaping them would kill another
   * instance's in-flight turns. The instance lock makes that combination
   * unreachable, and this makes it harmless if it ever becomes reachable
   * again.
   */
  ownerPid: number;
  children: JournaledChild[];
}

const JOURNAL_VERSION = 1;

/** Where a journal failure is reported. Never throws into a spawn path. */
export interface ChildJournalLogger {
  warn(message: string): void;
}

/**
 * A path-bound journal.
 *
 * Every method swallows its own I/O failure after reporting it: a full disk
 * must degrade this to "strays are not tracked this launch", never to a turn
 * that fails to start. The read side is the one place that must NOT swallow
 * quietly — an unreadable journal is indistinguishable from an empty one, and
 * both must reap nothing, so the log line is the only signal there is.
 */
export class ChildJournal {
  private readonly children = new Map<number, JournaledChild>();

  constructor(
    private readonly path: string,
    private readonly logger?: ChildJournalLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a live process group. Returns what was recorded, for the caller's log. */
  record(pid: number, command: string): JournaledChild {
    const entry: JournaledChild = { pid, startedAt: this.now(), command };
    this.children.set(pid, entry);
    this.flush();
    return entry;
  }

  /** Drop a group that has exited. */
  forget(pid: number): void {
    if (this.children.delete(pid)) {
      this.flush();
    }
  }

  /** Groups this instance believes are live — the in-memory half. */
  live(): JournaledChild[] {
    return [...this.children.values()];
  }

  private flush(): void {
    const file: ChildJournalFile = {
      version: JOURNAL_VERSION,
      ownerPid: process.pid,
      children: [...this.children.values()],
    };
    try {
      atomicWriteSync(this.path, JSON.stringify(file));
    } catch (err) {
      this.logger?.warn(
        `could not write the child journal at ${this.path}: ${errorText(err)} — strays from this launch will not be reaped`,
      );
    }
  }
}

/**
 * Read a journal left by a previous launch.
 *
 * Returns null for "there is nothing to act on", which deliberately covers a
 * missing file, an unreadable one, and one whose contents do not parse as this
 * version's shape. A caller must not be able to tell those apart, because the
 * only safe response to all three is the same: reap nothing.
 */
export function readChildJournal(
  path: string,
  logger?: ChildJournalLogger,
): ChildJournalFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // No journal — a first launch, or a clean previous shutdown.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isChildJournalFile(parsed)) {
      logger?.warn(
        `child journal at ${path} is not in a shape this daemon understands — ignoring it`,
      );
      return null;
    }
    return parsed;
  } catch (err) {
    logger?.warn(
      `could not parse the child journal at ${path}: ${errorText(err)} — ignoring it`,
    );
    return null;
  }
}

/** Remove the journal file, after its entries have been dealt with. */
export function clearChildJournal(path: string): void {
  rmSync(path, { force: true });
}

function isChildJournalFile(value: unknown): value is ChildJournalFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { version, ownerPid, children } = value as Record<string, unknown>;
  return (
    version === JOURNAL_VERSION &&
    typeof ownerPid === 'number' &&
    Array.isArray(children) &&
    children.every(isJournaledChild)
  );
}

function isJournaledChild(value: unknown): value is JournaledChild {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { pid, startedAt, command } = value as Record<string, unknown>;
  return (
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof startedAt === 'number' &&
    typeof command === 'string'
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The journal every production spawn writes to.
 *
 * Process-global because the thing it describes is process-global — the set of
 * groups THIS daemon has running — and because the two spawn sites that must
 * record ({@link trackDetachedChild}'s callers) sit at the bottom of the
 * adapter layer, below any DI. Threading a collaborator down to them would
 * have meant an optional parameter at four call sites, and an optional
 * collaborator is one a caller can quietly omit; this module's own history
 * (`AgentAdapterOptions.logger`, which shipped undefined into the one build
 * that mattered) is the argument against that.
 *
 * Disabled until {@link configureChildJournal} runs, so a unit test that
 * spawns a real child never writes into a developer's userData dir.
 */
let activeJournal: ChildJournal | null = null;

/**
 * Point the journal at a file and start recording. Called once, at boot,
 * BEFORE anything can spawn.
 */
export function configureChildJournal(
  path: string,
  logger?: ChildJournalLogger,
): ChildJournal {
  activeJournal = new ChildJournal(path, logger);
  return activeJournal;
}

/** Test seam: forget the configured journal. */
export function resetChildJournal(): void {
  activeJournal = null;
}

/** The configured journal, or null when nothing is being recorded. */
export function currentChildJournal(): ChildJournal | null {
  return activeJournal;
}

/**
 * The slice of a spawned child this journal touches: a pid and one exit
 * listener.
 *
 * Stated structurally rather than as `Pick<ChildProcess, 'pid' | 'once'>`,
 * which drags in that interface's overloaded `once` — only a real
 * `ChildProcess` satisfies it, so a spec could not substitute a plain
 * `EventEmitter` and would have to cast. Same reasoning as `CrashGuardTarget`
 * in `utils/crash-guards.ts`.
 */
export interface JournalableChild {
  readonly pid?: number;
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Record a freshly spawned DETACHED child, and erase it when it exits.
 *
 * Called from inside each spawn helper rather than from a registration site
 * further up: the pid exists here and nowhere earlier, and a record written
 * later leaves a window in which a group is running and unrecorded.
 *
 * Only detached (group-leading) spawns pass through here. A plain `execFile`
 * utility child is deliberately NOT journaled: it is a single pid with node's
 * own `timeout` on it, it is a `--version` probe that exits in well under a
 * second, and journaling it would write the file twice per probe to protect
 * against an orphan that costs nothing. The ones that pass through here are
 * the ones that cost hundreds of megabytes and never exit on their own.
 *
 * A no-op when the journal is unconfigured, so spawn behaviour is unchanged in
 * tests and in any embedding that never called {@link configureChildJournal}.
 */
export function trackDetachedChild(
  child: JournalableChild,
  command: string,
): void {
  const journal = activeJournal;
  const pid = child.pid;
  if (!journal || typeof pid !== 'number') {
    return;
  }
  journal.record(pid, command);
  // `exit` (not `close`): the leader is gone by then, and the leader is the
  // only thing whose identity the reaper can verify. A grandchild that
  // outlives it is already beyond what a pid-keyed journal can describe — the
  // group kill at cancel/shutdown is what covers those.
  child.once('exit', () => journal.forget(pid));
}
