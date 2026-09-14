import type { AgentEvent } from '../adapters/adapter.types';

/** One change to a run's counts, as the owner announces it on `run_status`. */
export type BackgroundCountsPatch =
  { shellsOpen: number } | { subagentsOut: number };

/**
 * How many DETACHED commands and background SUB-AGENTS each run still has out —
 * the figures `RunWire.shellsOpen` / `subagentsOut` carry.
 *
 * Read off the ANNOUNCEMENTS `runCliSession` makes (`shell_open` / `shell_info`,
 * and a `subagent_info` stating `backgroundOpen`), never off the
 * `background_work` bracket they are derived from, which is turn plumbing and is
 * not forwarded to the owner.
 *
 * On the run ROW rather than derived from a transcript, because a transcript is
 * knowable for the thread a window has open and for no other: a settled chat
 * with a `sleep` still out read `working` while selected and `completed` the
 * moment it was not. And shared by BOTH owners — `ChatService` and
 * `GraphExecutorService` — because a workflow run is listed in the same sidebar
 * and was reporting 0 for both figures by default, so its badge could never
 * reach the held state and its shelf never saw a delegate launched earlier than
 * the loaded page.
 *
 * SETS of ids rather than counters: a CLI is free to report one unit's end on
 * both of its terminal channels (claude does, 7ms apart), and a counter would go
 * negative or latch on the double. For the same reason a close announces only
 * when it actually retired something. IN MEMORY, and consistent with the
 * transcript: every unit's ending is written as a row (by the CLI, by a session
 * close, or by the next boot's sweep), so a restart finds both saying nothing
 * is out.
 */
export class BackgroundWorkCounts {
  private readonly shells = new Map<string, Set<string>>();
  private readonly delegates = new Map<string, Set<string>>();

  constructor(
    private readonly announce: (
      runId: string,
      patch: BackgroundCountsPatch,
    ) => void,
  ) {}

  /** Apply one agent event; anything that is not a bracket is ignored. */
  record(runId: string, event: AgentEvent): void {
    if (event.type === 'shell_open') {
      add(this.shells, runId, event.workId);
      this.announce(runId, { shellsOpen: this.shellsOpen(runId) });
      return;
    }
    if (event.type === 'shell_info') {
      this.noteShellClosed(runId, event.workId);
      return;
    }
    if (event.type !== 'subagent_info' || event.backgroundOpen === null) {
      return;
    }
    if (event.backgroundOpen) {
      add(this.delegates, runId, event.id);
      this.announce(runId, { subagentsOut: this.subagentsOut(runId) });
      return;
    }
    if (remove(this.delegates, runId, event.id)) {
      this.announce(runId, { subagentsOut: this.subagentsOut(runId) });
    }
  }

  /**
   * A detached command closed by a road the CLI does not travel — the user's
   * kill. A shell whose open recorded no work id is a no-op: the set is keyed by
   * that id, so there is nothing to remove.
   */
  noteShellClosed(runId: string, workId: string | null): void {
    if (workId !== null && remove(this.shells, runId, workId)) {
      this.announce(runId, { shellsOpen: this.shellsOpen(runId) });
    }
  }

  /**
   * Every delegate of a run is over at once — the process that ran them has
   * gone. Announces only when something was out.
   */
  retireDelegates(runId: string): void {
    if (this.delegates.delete(runId)) {
      this.announce(runId, { subagentsOut: 0 });
    }
  }

  /** A deleted run: nothing can be waiting on either set, and nothing is told. */
  forget(runId: string): void {
    this.shells.delete(runId);
    this.delegates.delete(runId);
  }

  shellsOpen(runId: string): number {
    return this.shells.get(runId)?.size ?? 0;
  }

  subagentsOut(runId: string): number {
    return this.delegates.get(runId)?.size ?? 0;
  }
}

function add(map: Map<string, Set<string>>, runId: string, id: string): void {
  const set = map.get(runId);
  if (set) {
    set.add(id);
  } else {
    map.set(runId, new Set([id]));
  }
}

function remove(
  map: Map<string, Set<string>>,
  runId: string,
  id: string,
): boolean {
  const set = map.get(runId);
  if (!set?.delete(id)) {
    return false;
  }
  if (set.size === 0) {
    map.delete(runId);
  }
  return true;
}
