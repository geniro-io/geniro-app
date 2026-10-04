import { Injectable, Logger } from '@nestjs/common';

import type {
  TaskBoardHandler,
  TaskBoardTool,
  TaskBoardToolAnswer,
} from '../graphs.types';

/**
 * The rendezvous behind the board tools (`HOST_BOARD_TOOLS`).
 *
 * The MCP host lives in this module and the board in the tasks module, which
 * imports this one — so the tasks side INSTALLS a handler here at boot and the
 * host looks it up per call. Unlike the render family's `HostSinkBroker` this is
 * one handler for the whole daemon rather than a sink per turn: the board is
 * durable state, answerable whether or not a turn is running.
 *
 * Neither method throws. A board that cannot answer is an outcome the agent
 * reads and carries on from, where a throw would cross MCP as a tool error
 * about the agent's own call.
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

  /** The tools to list — none while no board is installed. */
  tools(): readonly TaskBoardTool[] {
    return this.handler?.tools() ?? [];
  }

  async call(
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<TaskBoardToolAnswer> {
    if (this.handler === null) {
      return { text: 'The task board is not available.', isError: true };
    }
    try {
      return await this.handler.call(runId, name, args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`board tool ${name} failed for run ${runId}: ${reason}`);
      return { text: `The board could not answer: ${reason}`, isError: true };
    }
  }
}
