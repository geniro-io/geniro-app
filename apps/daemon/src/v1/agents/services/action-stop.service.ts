import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type {
  ActionPressResult,
  ActionSpec,
  ActionStopInput,
  ActionStopSpec,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { maskedCommand } from '../utils/command-text';
import { asRecord, asString, parseJsonColumn } from '../utils/json-util';
import {
  isDelegateCall,
  launchingCallOf,
  shellCommandOf,
  type StrandedShell,
  strandedShells,
} from '../utils/open-shells';
import { commandTargets } from '../utils/process-descendants';
import type { StopCandidate } from '../utils/run-process-scan';
import { RunProcessReaper } from './run-process-reaper.service';

/** A stop target's command as the card shows it; argv can run long. */
const STOP_COMMAND_MAX = 200;

const NAME_A_PID =
  'start the process detached and publish stop.pid instead — e.g. ' +
  '`nohup <command> > <log> 2>&1 & echo $!` prints its pid';

/**
 * The processes a stop action stops: chosen when the agent publishes it, from
 * the run's own processes as {@link RunProcessReaper.stopCandidates} allows,
 * and stopped on a press by {@link RunProcessReaper.stopRecorded} — never by a
 * pid alone, never by a command-text match across the machine.
 */
@Injectable()
export class ActionStopService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly reaper: RunProcessReaper,
  ) {}

  /**
   * The targets of a stop published by the conversation filed under `nodeId`,
   * or why there are none. A reason goes back to the agent.
   */
  async resolve(
    runId: string,
    nodeId: string | null,
    stop: ActionStopInput,
  ): Promise<ActionStopSpec | { reason: string }> {
    try {
      if (stop.pid !== undefined) {
        const candidates = await this.reaper.stopCandidates(runId);
        const row = candidates.find((process) => process.pid === stop.pid);
        return row === undefined
          ? {
              reason:
                `pid ${stop.pid} is not a running process of this chat that can be stopped — it must be ` +
                'one this chat started, never your own process or its tool servers',
            }
          : { targets: [targetOf(row)] };
      }
      return await this.resolveShell(runId, nodeId, stop.shell ?? '');
    } catch (err) {
      if (err instanceof BadRequestException) {
        return { reason: err.message };
      }
      throw err;
    }
  }

  /** Stops what `spec` recorded, as the outcome a press writes. */
  async stop(runId: string, spec: ActionSpec): Promise<ActionPressResult> {
    const targets = (spec.targets ?? []).map((target) => ({
      pid: target.pid,
      startedAt: Date.parse(target.startedAt),
    }));
    if (
      targets.length === 0 ||
      targets.some((target) => Number.isNaN(target.startedAt))
    ) {
      return {
        state: 'failed',
        error: 'this action names no process geniro can confirm',
      };
    }
    try {
      const { stopped } = await this.reaper.stopRecorded(runId, targets);
      return stopped.length === 0
        ? { state: 'stopped', alreadyStopped: true }
        : { state: 'stopped' };
    } catch (err) {
      if (err instanceof BadRequestException) {
        return { state: 'failed', error: err.message };
      }
      throw err;
    }
  }

  private async resolveShell(
    runId: string,
    nodeId: string | null,
    shellId: string,
  ): Promise<ActionStopSpec | { reason: string }> {
    const em = this.em.fork();
    const rows = (await this.itemDao.shellRows(runId, em)).filter(
      (row) => row.nodeId === nodeId,
    );
    const shells = strandedShells(rows);
    // The fold keys a node's shells by work id, and an ACP work id is a call
    // id each session restarts — so another conversation's shell by the same
    // id is only visible in the rows, and makes the id ambiguous.
    const callsNaming = new Set(
      rows.flatMap((row) => {
        const open = asRecord(parseJsonColumn(row.payload));
        return row.kind === 'shell_open' &&
          (asString(open?.workId) === shellId || asString(open?.id) === shellId)
          ? [asString(open?.callId) || null]
          : [];
      }),
    );
    if (callsNaming.size > 1) {
      return {
        reason: `"${shellId}" names background commands in more than one conversation, so geniro cannot tell which one is yours; ${NAME_A_PID}`,
      };
    }
    const shell = shells.find(
      (open) => open.workId === shellId || open.toolCallId === shellId,
    );
    const calls = await this.itemDao.toolCallsByIds(
      runId,
      shells.flatMap((open) =>
        open.toolCallId === null ? [] : [open.toolCallId],
      ),
      em,
    );
    // A delegate's command is never a shell of the agent's own.
    const commandOf = (open: StrandedShell): string | null => {
      const call = launchingCallOf(open, calls);
      return call === undefined || isDelegateCall(call)
        ? null
        : shellCommandOf(call.payload);
    };
    if (shell === undefined) {
      // Ids only: a node's other conversations share these rows, and their
      // command lines are not this conversation's to read.
      const running = shells.map((open) => open.workId);
      return {
        reason:
          `no background command "${shellId}" is running here. ` +
          (running.length === 0
            ? `None is; ${NAME_A_PID}.`
            : `Running: ${running.join(', ')}. A command started a moment ago may not be listed yet — ${NAME_A_PID}.`),
      };
    }
    const command = commandOf(shell);
    if (command === null) {
      return {
        reason: `geniro cannot tell which process "${shellId}" is — the call that started it names no command; ${NAME_A_PID}`,
      };
    }
    const candidates = await this.reaper.stopCandidates(runId);
    const tops = commandTargets(candidates, command);
    if (tops.length === 0) {
      return {
        reason: `"${shellId}" runs no process of this chat that can be stopped; ${NAME_A_PID}`,
      };
    }
    // The command text is all that ties a shell to a process, and the same
    // command in another shell or agent of the run matches it as well.
    if (tops.length > 1) {
      return {
        reason: `the command of "${shellId}" matches ${tops.length} separate processes of this chat, so geniro cannot tell which one is that shell; ${NAME_A_PID}`,
      };
    }
    return {
      shellId: shell.workId,
      targets: candidates
        .filter((row) => tops.includes(row.pid))
        .map((row) => targetOf(row)),
    };
  }
}

function targetOf(
  row: StopCandidate,
): NonNullable<ActionSpec['targets']>[number] {
  return {
    pid: row.pid,
    startedAt: new Date(row.startedAt).toISOString(),
    command: shown(row.args),
  };
}

/** One line, masked ({@link maskedCommand}), cut to what a card shows. */
function shown(command: string): string {
  const line = maskedCommand(command).replace(/\s+/g, ' ').trim();
  return line.length > STOP_COMMAND_MAX
    ? `${line.slice(0, STOP_COMMAND_MAX - 1)}…`
    : line;
}
