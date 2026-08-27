import { Injectable, Logger } from '@nestjs/common';

import type { HostQuestion, HostQuestionOutcome } from '../chat.types';

/**
 * Puts a host-asked question (`HOST_QUESTION_TOOL`) to the user, for a CLI
 * whose own model has no way to ask one.
 *
 * A RENDEZVOUS and nothing more: the MCP endpoint knows how to receive the
 * call, the turn that owns the run knows how to put a card on screen and how
 * to read a verdict back, and the two are in different modules. Whoever is
 * running the turn registers an asker for the length of that turn; the tool
 * looks one up. Nothing here persists an item, tracks an approval or touches
 * the event bus — doing any of that would be a second producer of the same
 * card, free to disagree with the one the CLI's own questions already go
 * through.
 *
 * In memory, and deliberately per LAUNCH: a parked question is a live promise
 * held by a live turn, so an entry that outlived either would be answered into
 * nothing.
 */
export type HostQuestionAsker = (
  questions: HostQuestion[],
  title: string | null,
) => Promise<HostQuestionOutcome>;

@Injectable()
export class UserQuestionBroker {
  private readonly logger = new Logger(UserQuestionBroker.name);
  private readonly askers = new Map<string, HostQuestionAsker>();

  private key(runId: string, nodeId: string): string {
    return `${runId}::${nodeId}`;
  }

  /**
   * Install the asker for one node's turn; the returned disposer removes it.
   *
   * Returns a disposer rather than exposing an `unregister(runId, nodeId)`,
   * so a turn cannot tear down the asker a LATER turn of the same run
   * installed — the settle paths run late and out of order, and a keyed
   * removal there would silently unregister its successor.
   */
  register(
    runId: string,
    nodeId: string,
    asker: HostQuestionAsker,
  ): () => void {
    const key = this.key(runId, nodeId);
    this.askers.set(key, asker);
    return () => {
      if (this.askers.get(key) === asker) {
        this.askers.delete(key);
      }
    };
  }

  /** Whether this node can currently be asked — what gates the tool listing. */
  canAsk(runId: string, nodeId: string): boolean {
    return this.askers.has(this.key(runId, nodeId));
  }

  /**
   * Put the question and resolve with what came back.
   *
   * Never throws: an ask that cannot be put is an OUTCOME the agent reads and
   * carries on from, where a throw would cross the MCP transport as a tool
   * error and read to the model as its own call being malformed.
   */
  async ask(
    runId: string,
    nodeId: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    const asker = this.askers.get(this.key(runId, nodeId));
    if (!asker) {
      return {
        status: 'unavailable',
        reason: 'no turn is running that could put this question on screen',
      };
    }
    try {
      return await asker(questions, title);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `run ${runId}/${nodeId} could not ask the user: ${message}`,
      );
      return { status: 'unavailable', reason: message };
    }
  }
}
