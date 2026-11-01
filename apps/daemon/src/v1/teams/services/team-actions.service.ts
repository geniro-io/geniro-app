import { Injectable } from '@nestjs/common';

import type {
  ActionPressWire,
  ActionVia,
  LiveAction,
} from '../../agents/chat.types';
import { ActionPressService } from '../../agents/services/action-press.service';
import { GraphExecutorService } from './graph-executor.service';

/**
 * A press or dismissal of a button in a TEAM run — the chat's press, with
 * the run's own delivery. Here rather than in `v1/agents` for
 * `TeamChatService`'s reason: `TeamsModule` imports `AgentsModule`, so
 * only this side can reach the executor.
 *
 * A message goes where a typed one does — the agents the run's trigger feeds
 * (`GraphExecutorService.sendMessage`) — never back to the publisher's own
 * conversation, which may have settled long before the press.
 */
@Injectable()
export class TeamActionsService {
  constructor(
    private readonly presses: ActionPressService,
    private readonly executor: GraphExecutorService,
  ) {}

  async press(
    runId: string,
    seq: number,
    clientMessageId: string,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.presses.press(runId, seq, {
      run: 'team',
      clientMessageId,
      via,
      deliverMessage: (text, id, action) =>
        this.executor.sendMessage(runId, attributed(text, action), [], id),
    });
  }

  async dismiss(
    runId: string,
    seq: number,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.presses.dismiss(runId, seq, via, 'team');
  }
}

/**
 * The press's message as the receiving agents read it: prefixed with who
 * published it whenever the publisher carries an `agentLabel`, which
 * `GraphExecutorService.registerActionPublishers` withholds only from the
 * run's sole trigger-fed agent speaking in its own conversation.
 */
function attributed(text: string, action: LiveAction): string {
  const agent = action.publisher.agentLabel;
  return agent === undefined
    ? text
    : `From ${agent} (action "${action.label}"):\n${text}`;
}
