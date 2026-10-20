import { Injectable } from '@nestjs/common';

import type { ActionPublishInput, ActionToolOutcome } from '../chat.types';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * One turn's publisher of buttons (`publish_action` / `remove_action`): the
 * conversation it publishes as is bound in, so no tool takes it from the model.
 */
export interface ActionSink {
  publish(input: ActionPublishInput): Promise<ActionToolOutcome>;
  remove(actionId: string): Promise<ActionToolOutcome>;
}

/**
 * Hands an agent's button to the turn that can put it in the chat. A
 * rendezvous only — the mechanics live in {@link HostSinkBroker}.
 */
@Injectable()
export class ActionBroker extends HostSinkBroker<ActionSink> {
  /** Whether this node can currently publish — gates both tools' listing. */
  canPublish(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  async publish(
    runId: string,
    nodeId: string,
    input: ActionPublishInput,
  ): Promise<ActionToolOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could show it',
      'publish an action',
      (sink) => sink.publish(input),
    );
  }

  async remove(
    runId: string,
    nodeId: string,
    actionId: string,
  ): Promise<ActionToolOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could remove it',
      'remove an action',
      (sink) => sink.remove(actionId),
    );
  }
}
