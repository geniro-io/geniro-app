import { Injectable } from '@nestjs/common';

import type { HostQuestion, HostQuestionOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Puts a host-asked question (`HOST_QUESTION_TOOL`) to the user, for a CLI
 * whose own model has no way to ask one.
 *
 * A rendezvous and nothing more — the mechanics, and why they are what they
 * are, live in {@link HostSinkBroker}. What is this tool's own: an ask PARKS.
 * The returned promise is held open by a live turn until a verdict comes back
 * from the card, which is why an entry outliving its turn would be answered
 * into nothing.
 */
export type HostQuestionAsker = (
  questions: HostQuestion[],
  title: string | null,
  signal?: AbortSignal,
) => Promise<HostQuestionOutcome>;

@Injectable()
export class UserQuestionBroker extends HostSinkBroker<HostQuestionAsker> {
  /** Whether this member can currently be asked — gates the tool listing. */
  canAsk(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  /**
   * Put the question and resolve with what came back. Never throws.
   *
   * `signal` is the CALLER abandoning its own call — an agent whose MCP client
   * put a deadline on the `tools/call` and gave up on it. Optional so a caller
   * with no such signal is unchanged; a card raised without one can only ever
   * be closed by a verdict or by the turn settling.
   */
  async ask(
    runId: string,
    memberId: string,
    questions: HostQuestion[],
    title: string | null,
    signal?: AbortSignal,
  ): Promise<HostQuestionOutcome> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could put this question on screen',
      'ask the user',
      (asker) => asker(questions, title, signal),
    );
  }
}
