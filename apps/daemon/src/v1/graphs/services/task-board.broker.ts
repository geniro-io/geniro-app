import { Injectable, Logger } from '@nestjs/common';

import type {
  TaskBoardCard,
  TaskBoardHandler,
  TaskBoardUpdate,
  TaskBoardUpdateOutcome,
} from '../graphs.types';

/**
 * The rendezvous behind the board tools (`get_task`, `update_task`).
 *
 * The MCP host lives in this module and the board in the tasks module, which
 * imports this one — so the tasks side INSTALLS a handler here at boot and the
 * host looks it up per call. Unlike the render family's `HostSinkBroker` this is
 * one handler for the whole daemon rather than a sink per turn: a card is
 * durable state, answerable whether or not a turn is running, so nothing here
 * closes over a turn.
 *
 * Neither method throws. A board that cannot answer is an outcome the agent
 * reads and carries on from — it can still write its report into its reply —
 * where a throw would cross MCP as a tool error about the agent's own call.
 */
@Injectable()
export class TaskBoardBroker {
  private readonly logger = new Logger(TaskBoardBroker.name);
  private handler: TaskBoardHandler | null = null;

  /**
   * Install the board; the returned disposer removes it. Identity-checked, so
   * a stale disposer cannot remove a handler installed after it.
   */
  install(handler: TaskBoardHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  /**
   * The card a run works — what gates the tool LISTING, so an agent that is
   * not working a card is never offered tools about one.
   */
  async cardFor(runId: string): Promise<TaskBoardCard | null> {
    if (this.handler === null) {
      return null;
    }
    try {
      return await this.handler.cardFor(runId);
    } catch (err) {
      this.logger.warn(
        `could not read the card for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async update(
    runId: string,
    update: TaskBoardUpdate,
  ): Promise<TaskBoardUpdateOutcome> {
    if (this.handler === null) {
      return { status: 'refused', reason: 'the task board is not available' };
    }
    try {
      return await this.handler.update(runId, update);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not update the card for run ${runId}: ${reason}`);
      return { status: 'refused', reason };
    }
  }
}
