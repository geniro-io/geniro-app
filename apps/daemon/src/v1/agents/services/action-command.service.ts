import { isAbsolute } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import {
  ACTION_OUTPUT_TAIL_MAX,
  type ActionCommandSpec,
  type ActionPressResult,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { runManagedCommand } from '../utils/managed-command';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { runTagEnv } from '../utils/run-process-scan';
import type { ActionCommandAbortReason } from './action-command.registry';
import { ProcessRegistry } from './process-registry';
import { currentRunOwner } from './run-process-attribution.service';

/** How a command action's run ended, for its outcome row and the agent. */
export interface ActionCommandRun {
  result: ActionPressResult;
  /** Ended by archive or delete: the agent is not told. */
  aborted: boolean;
}

/**
 * Where a command action runs, chosen when the agent publishes it, and the run
 * itself once the user confirmed it: argv only, in the run's folder unless the
 * agent named another, tagged with the run so its process panel and its
 * archive see it, registered and journaled by `runManagedCommand`.
 */
@Injectable()
export class ActionCommandService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly processes: ProcessRegistry,
  ) {}

  /**
   * The folder a command published in this run runs in: `cwd` when given (an
   * existing absolute directory, canonicalized), else the run's own.
   */
  async resolveCwd(
    runId: string,
    cwd: string | undefined,
  ): Promise<{ cwd: string } | { reason: string }> {
    let folder = cwd;
    if (folder === undefined) {
      const run = await this.runDao.getById(runId, this.em.fork());
      if (run === null || run.cwd === null || run.cwd === '') {
        return {
          reason: 'this chat has no working folder; give command.cwd',
        };
      }
      folder = run.cwd;
    } else if (!isAbsolute(folder)) {
      return { reason: 'command.cwd must be an absolute path' };
    }
    try {
      return { cwd: resolveValidCwd(folder) };
    } catch (err) {
      if (err instanceof BadRequestException) {
        return { reason: `command.cwd: ${err.message}` };
      }
      throw err;
    }
  }

  /**
   * Runs a confirmed command to its end; `signal` (the run's
   * `ActionCommandRegistry` slot) ends it early. Never throws.
   */
  async run(
    runId: string,
    spec: ActionCommandSpec,
    signal: AbortSignal,
  ): Promise<ActionCommandRun> {
    const [command, ...args] = spec.argv;
    // The dialog showed this folder; one swapped since for a link elsewhere
    // would run the command somewhere the user never saw.
    const folder = await this.resolveCwd(runId, spec.cwd);
    if ('reason' in folder || folder.cwd !== spec.cwd) {
      return {
        result: {
          state: 'failed',
          exitCode: null,
          error:
            'reason' in folder
              ? folder.reason
              : `command.cwd now leads to ${folder.cwd}, not the folder shown`,
        },
        aborted: false,
      };
    }
    const result = await runManagedCommand({
      label: `action:${runId}`,
      command,
      args,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      processes: this.processes,
      env: runTagEnv(runId, currentRunOwner()),
      maxOutputChars: ACTION_OUTPUT_TAIL_MAX + SECRET_MARGIN,
      keepOutput: 'tail',
      endGroupOnExit: true,
      signal,
    });
    const outputTail = tailOf(result.output ?? '');
    const output = outputTail === '' ? {} : { outputTail };
    if (signal.aborted) {
      return {
        result: {
          state: 'interrupted',
          exitCode: null,
          error:
            signal.reason === ('shutdown' satisfies ActionCommandAbortReason)
              ? 'the app stopped while it ran'
              : 'stopped with its chat',
          ...output,
        },
        aborted: true,
      };
    }
    if (result.spawnError !== undefined) {
      return {
        result: {
          state: 'failed',
          exitCode: null,
          error: `could not start: ${result.spawnError}`,
        },
        aborted: false,
      };
    }
    if (result.timedOut) {
      return {
        result: {
          state: 'failed',
          exitCode: null,
          error: `timed out after ${Math.round(spec.timeoutMs / 60_000)} min`,
          ...output,
        },
        aborted: false,
      };
    }
    return {
      result:
        result.code === 0
          ? { state: 'succeeded', exitCode: 0, ...output }
          : {
              state: 'failed',
              exitCode: result.code,
              error:
                result.code === null
                  ? 'killed by a signal'
                  : `exit ${result.code}`,
              ...output,
            },
      aborted: false,
    };
  }
}

/**
 * Output read past the tail that is kept, so a registered secret the cut
 * would split is still whole when it is masked.
 */
const SECRET_MARGIN = 4096;

/**
 * The end of what the command printed, masked before it is cut — it is
 * written to the transcript and may be handed to the agent's model.
 */
function tailOf(output: string): string {
  const masked = redactSecrets(output);
  // Masks are shorter than what they hide: past the cap, the margin's start
  // (possibly a secret the window cut through) must never move into the tail.
  return (
    output.length >= ACTION_OUTPUT_TAIL_MAX + SECRET_MARGIN
      ? masked.slice(SECRET_MARGIN)
      : masked
  ).slice(-ACTION_OUTPUT_TAIL_MAX);
}
