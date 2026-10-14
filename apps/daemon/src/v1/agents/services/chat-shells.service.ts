import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { ChatShellsWire, OpenShell, ShellKillWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { asRecord, asString } from '../utils/json-util';
import { GROUP_KILL_GRACE_MS, killProcessGroup } from '../utils/kill-tree';
import { persistItemAndEmit } from '../utils/persist-item';
import {
  commandNeedles,
  descendantsOf,
  listProcesses,
  pidsRunningCommand,
  type ProcessRow,
} from '../utils/process-descendants';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ChatService } from './chat.service';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/**
 * What a run still has RUNNING in a terminal, over the whole conversation.
 *
 * The renderer folds the same list from the loaded transcript window, which is
 * the right shape for a list it draws beside the rows it came from — and the
 * wrong shape for the question "what is running", because a command detached
 * before that window has no row there to fold. The run row keeps counting it,
 * so the badge reads `working` while the shelf draws nothing: two correct
 * answers to two different questions, which on screen reads as the app
 * contradicting itself.
 *
 * So this answers the whole-conversation version, on the same reasoning
 * `ChatTimelineService` is a daemon read rather than a client fold: the client
 * cannot fold what it has not loaded.
 *
 * Read-only, on a forked EntityManager — opening a chat must not write.
 */
@Injectable()
export class ChatShellsService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    /** For the close a killed command owes the transcript — see {@link kill}. */
    private readonly bus: AgentEventBus,
    private readonly seqs: ItemSeqAllocator,
    /**
     * For the run's LIVE shell count — see {@link close}.
     *
     * One way only: `ChatService` knows nothing about this service, so there is
     * no DI cycle. It is injected rather than reached through the bus because
     * the count is in-memory state that service owns, and a second tally kept
     * here is how a badge and a list come to disagree.
     */
    private readonly chats: ChatService,
    /**
     * The run's own CLI processes — the only place a FOREGROUND command is
     * looked for. See {@link killForeground}.
     */
    private readonly sessions: AgentSessionRegistry,
    private readonly calls: ItemCallIndexService,
  ) {}

  async read(runId: string): Promise<ChatShellsWire> {
    // A delegate's commands are its own: the run's live count still says every
    // detached command is out, while the list is the MAIN thread's.
    //
    // TWIN PARSER: `shellRuns` in apps/ui/src/renderer/chats/shell-activity.ts
    // drops a delegate's rows (`subagentIdOf`) on the same rule.
    const folded = (await this.fold(runId)).filter((row) => !row.delegate);
    const shells: OpenShell[] = folded.map((row) => ({
      id: row.id,
      // A command whose call could not be read is still RUNNING, and saying so
      // with its id beats dropping it — the count on the badge would then
      // outrun the list again, which is the whole defect this answers. It is a
      // DISPLAY fallback and nothing more: {@link kill} reads the fold's own
      // null instead, because an id is not a command and matching one against
      // the process table can only ever hit by accident.
      command: row.command ?? row.id,
      nodeId: row.nodeId,
      callId: row.callId,
      startedAt: row.startedAt,
    }));
    return { shells };
  }

  /** The open set, with an unreadable command left as the null it really is. */
  private async fold(runId: string): Promise<FoldedShell[]> {
    const em = this.em.fork();
    /**
     * Open commands, keyed by the call that detached them.
     *
     * A `Map` rather than a `Set` so the ROW that opened it is kept — its node
     * and its timestamp are what the list is drawn from, and the close carries
     * neither. Insertion-ordered, so the list reads oldest-first like the
     * transcript it comes from.
     */
    const open = new Map<
      string,
      {
        nodeId: string | null;
        callId: string | null;
        startedAt: number;
        workId: string | null;
      }
    >();
    for (const row of await this.itemDao.shellLifecycleRows(runId, em)) {
      const payload = asRecord(parse(row.payload));
      const id = asString(payload?.id);
      if (id === null || id === '') {
        continue;
      }
      if (row.kind === 'shell_open') {
        open.set(id, {
          nodeId: row.nodeId,
          callId: asString(payload?.callId),
          startedAt: row.createdAt.getTime(),
          // The CLI's OWN handle for this command, carried through so the close
          // a kill writes is the same shape every other close has — and so the
          // run's live count, which is keyed by exactly this, can come down
          // with it.
          workId: asString(payload?.workId),
        });
      } else {
        // `shell_info` is the daemon's own close. It is written for every shell
        // still out when the CLI process dies, so a run whose daemon was
        // SIGKILLed has its closes written by the next boot rather than never.
        open.delete(id);
      }
    }
    if (open.size === 0) {
      return [];
    }
    // The WORDS. A lifecycle row names the call and nothing else, so the
    // command is read from the call it decorates — matched by id, and read
    // only while a command is open.
    const commands = new Map<string, string>();
    const delegates = new Set<string>();
    for (const row of await this.itemDao.toolCallsByIds(
      runId,
      [...open.keys()],
      em,
    )) {
      const payload = asRecord(parse(row.payload));
      const id = asString(payload?.id);
      if (id === null || !open.has(id)) {
        continue;
      }
      const parent = asString(payload?.parentToolUseId);
      if (parent !== null && parent !== '') {
        delegates.add(id);
      }
      const command =
        asString(asRecord(payload?.input)?.command) ?? asString(payload?.name);
      if (command !== null && command !== '') {
        commands.set(id, command);
      }
    }
    const shells: FoldedShell[] = [];
    for (const [id, row] of open) {
      shells.push({
        id,
        command: commands.get(id) ?? null,
        nodeId: row.nodeId,
        callId: row.callId,
        startedAt: row.startedAt,
        workId: row.workId,
        delegate: delegates.has(id),
      });
    }
    return shells;
  }

  /**
   * Stop one of those commands.
   *
   * ASKED FOR as "i wanna have an ability to kill terminals". Until now the
   * only thing that could stop a detached command was the AGENT calling its own
   * `KillShell`, so a `pnpm dev` left up by a thread the user had finished with
   * ran until they found it in Activity Monitor — and the six this run still
   * held had been up for a day.
   *
   * The process table is what makes it possible, and it is the same reading
   * `sweepDetachedShells` already takes: the command is OURS, so it is in the
   * table with its own arguments. It cannot be reached as a DESCENDANT of the
   * CLI child, which is the whole point — these outlive the process that
   * started them and are reparented to launchd.
   *
   * SIGTERM, then SIGKILL after {@link GROUP_KILL_GRACE_MS}. A `pnpm dev` holds
   * child processes of its own and writes files; asking it to stop before
   * making it is the same courtesy every other kill path here extends.
   *
   * The GROUP rather than the pid, for the reason `pidsRunningCommand`'s doc
   * gives: a CLI wraps what it runs, so one command is routinely two rows, and
   * killing the leaf would leave the wrapper holding the terminal.
   *
   * It writes the CLOSE itself. Nothing else will — the row that would have
   * announced it is the CLI's own bracket, and the CLI is gone — so without it
   * the command would go on being listed as running by the very fold that just
   * killed it.
   */
  async kill(runId: string, callId: string): Promise<ShellKillWire> {
    const shell = (await this.fold(runId)).find((row) => row.id === callId);
    if (shell === undefined) {
      // Not a DETACHED command. The panel also lists a foreground one — a
      // command call the CLI has not answered yet — so that is asked next.
      return this.killForeground(runId, callId);
    }
    if (shell.command === null) {
      // The list drew this row under its ID, because the call that started it
      // could not be read. An id is not a command, and the match below is a
      // PREFIX — so signalling on one could only ever hit by accident, and what
      // it hit would be someone else's process. Saying so beats both killing
      // the wrong thing and pretending the row is not there.
      return {
        killed: false,
        reason:
          'geniro cannot tell which process this is — the call that started it is no longer readable',
      };
    }
    const pids = pidsRunningCommand(await listProcesses(), shell.command);
    if (pids.length === 0) {
      // The transcript says open and the machine says otherwise — a command
      // that died with no one to write its close. Recording it is the useful
      // answer, and it is what takes the row off the list.
      await this.close(runId, shell);
      return {
        killed: false,
        reason: 'that command had already stopped — the list is now up to date',
      };
    }
    for (const pid of pids) {
      killProcessGroup(pid, 'SIGTERM', () => process.kill(pid, 'SIGTERM'));
    }
    setTimeout(() => {
      for (const pid of pids) {
        killProcessGroup(pid, 'SIGKILL', () => process.kill(pid, 'SIGKILL'));
      }
    }, GROUP_KILL_GRACE_MS).unref();
    await this.close(runId, shell);
    return { killed: true, reason: null };
  }

  /**
   * Stop a FOREGROUND command — one the agent is still waiting on.
   *
   * REPORTED as a Stop on a running terminal answering "that command is no
   * longer running" over a `pnpm dev` that ran on for twenty minutes. The panel
   * lists a command call the CLI has not answered as running, while this
   * service knew only DETACHED commands (`shell_open` rows), so every
   * foreground row was refused without a look.
   *
   * Found by ATTRIBUTION first and matching second. The search is confined to
   * the processes under this run's own live CLI processes
   * ({@link AgentSessionRegistry.processRoots}), so the looser needles
   * {@link commandNeedles} derives — needed because a shell execs the command
   * and the written text is gone from the table — can never reach the user's
   * own `pnpm dev` in another terminal. The CLI root itself is never a target.
   *
   * The whole TREE is stopped, not a group: a foreground command usually shares
   * its CLI's process group, so a group kill would fall back to the one pid and
   * leave everything it started (a dev server's own children) running.
   *
   * Nothing is written to the transcript. The CLI is still there, sees its
   * command exit, and answers the call itself — which is what takes the row
   * off the list.
   */
  private async killForeground(
    runId: string,
    callId: string,
  ): Promise<ShellKillWire> {
    const rows = await this.itemDao.rowsByPayloadId(
      runId,
      ['tool_call', 'tool_result'],
      [callId],
      undefined,
      this.em.fork(),
    );
    const call = rows.find((row) => row.kind === 'tool_call');
    if (call === undefined || rows.some((row) => row.kind === 'tool_result')) {
      // Answered already, or never this run's. Not an error: the list a user
      // pressed from is a snapshot, and a command that finished between the
      // render and the press is the ordinary race. It is also what scopes a
      // press to its OWN conversation.
      return { killed: false, reason: 'that command is no longer running' };
    }
    const command = asString(
      asRecord(asRecord(parse(call.payload))?.input)?.command,
    );
    if (command === null || command.trim() === '') {
      return {
        killed: false,
        reason:
          'geniro cannot tell which process this is — the agent did not say what it ran',
      };
    }
    const roots = this.sessions.processRoots(runId);
    if (roots.length === 0) {
      return {
        killed: false,
        reason:
          'the agent process that started this command is gone, so geniro cannot tell which process is its own',
      };
    }
    const table = await listProcesses();
    const owned = roots.flatMap((root) => descendantsOf(table, root.pid));
    const targets = foregroundTargets(owned, command);
    if (targets.length === 0) {
      return {
        killed: false,
        reason:
          'geniro could not find this command among the agent’s processes — stop the turn to end it',
      };
    }
    const pids = [
      ...new Set(
        targets.flatMap((pid) => [
          pid,
          ...descendantsOf(table, pid).map((row) => row.pid),
        ]),
      ),
    ];
    for (const pid of pids) {
      killProcessGroup(pid, 'SIGTERM', () => process.kill(pid, 'SIGTERM'));
    }
    setTimeout(() => {
      for (const pid of pids) {
        killProcessGroup(pid, 'SIGKILL', () => process.kill(pid, 'SIGKILL'));
      }
    }, GROUP_KILL_GRACE_MS).unref();
    return { killed: true, reason: null };
  }

  /**
   * The `shell_info` a killed command owes the transcript, and the count that
   * goes with it.
   *
   * TWO things, because the transcript and the badge are counted separately and
   * a kill has to reach both. The ROW is what every client's own fold retires —
   * same keys as `event-to-item.ts` writes, since this is the same close
   * arriving by another road. `Run.shellsOpen` is the live map `ChatService`
   * keeps off the CLI's own brackets, and nothing about a kill reaches those:
   * the launch was answered long ago and the process is now dead, so the CLI
   * will never bracket this command's end. Left alone, the badge would read
   * `working · waiting on background work` for the life of the session over a
   * command the user had just stopped — which is the exact defect, reached from
   * a new direction.
   */
  private async close(runId: string, shell: FoldedShell): Promise<void> {
    const em = this.em.fork();
    await persistItemAndEmit(
      { itemDao: this.itemDao, bus: this.bus, calls: this.calls },
      em,
      {
        runId,
        // The node that STARTED it, carried over from the open: a close filed at
        // the wrong node is a row the workflow's own transcript cannot show.
        nodeId: shell.nodeId,
        seq: await this.seqs.reserve(runId),
        kind: 'shell_info',
        role: null,
        payload: {
          id: shell.id,
          workId: shell.workId,
          // The one key a CLI's own close never carries. Nothing branches on it
          // today; it is what makes a transcript say who ended the command, which
          // is the only question a reader has about a row that stops mid-run.
          killedByUser: true,
        },
      },
    );
    this.chats.noteShellClosed(runId, shell.workId, shell.nodeId);
  }
}

/**
 * One open command as the FOLD knows it.
 *
 * `command` is nullable where {@link OpenShell}'s is not, and that difference is
 * the point: the wire shape is drawn on screen, where an id is a better label
 * than nothing, while a kill has to be able to tell "this is what it runs" from
 * "we could not read what it runs".
 */
interface FoldedShell {
  id: string;
  command: string | null;
  nodeId: string | null;
  callId: string | null;
  startedAt: number;
  /** The CLI's own handle, from the open — see {@link ChatShellsService.kill}. */
  workId: string | null;
  /** Started by a delegate rather than by the agent itself. */
  delegate: boolean;
}

/**
 * Which of a run's processes ARE this command: the matches of the most specific
 * needle that matches anything, each kept only when no ancestor of it matched
 * too — the wrapper and what it wraps are one command, stopped through the top.
 */
function foregroundTargets(
  owned: readonly ProcessRow[],
  command: string,
): number[] {
  for (const needle of commandNeedles(command)) {
    const matched = new Set(pidsRunningCommand(owned, needle));
    if (matched.size === 0) {
      continue;
    }
    const parentOf = new Map(owned.map((row) => [row.pid, row.ppid]));
    return [...matched].filter((pid) => {
      const seen = new Set<number>([pid]);
      let parent = parentOf.get(pid);
      while (parent !== undefined && !seen.has(parent)) {
        if (matched.has(parent)) {
          return false;
        }
        seen.add(parent);
        parent = parentOf.get(parent);
      }
      return true;
    });
  }
  return [];
}

/** A payload that will not parse is a row this fold skips, never a throw. */
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
