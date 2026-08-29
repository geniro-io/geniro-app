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
) => Promise<HostQuestionOutcome>;

@Injectable()
export class UserQuestionBroker extends HostSinkBroker<HostQuestionAsker> {
  /** Whether this node can currently be asked — gates the tool listing. */
  canAsk(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Put the question and resolve with what came back. Never throws. */
  async ask(
    runId: string,
    nodeId: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could put this question on screen',
      'ask the user',
      (asker) => asker(questions, title),
    );
  }
}
