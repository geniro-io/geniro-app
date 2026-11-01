import { Injectable } from '@nestjs/common';

import type { ActionPublishInput, ActionToolOutcome } from '../chat.types';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/**
 * One member's publisher of buttons (`publish_action` / `remove_action`). The
 * conversation it publishes as comes from the endpoint, never from the model:
 * `caller` is the MCP call's caller key, which a chat's sink may ignore and a
 * team member's reads to tell its own conversation from a callee's.
 */
export interface ActionSink {
  publish(
    input: ActionPublishInput,
    caller: string,
  ): Promise<ActionToolOutcome>;
  remove(actionId: string, caller: string): Promise<ActionToolOutcome>;
}

/**
 * Hands an agent's button to the turn that can put it in the chat. A
 * rendezvous only — the mechanics live in {@link HostSinkBroker}.
 */
@Injectable()
export class ActionBroker extends HostSinkBroker<ActionSink> {
  /** Whether this member can currently publish — gates both tools' listing. */
  canPublish(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  async publish(
    runId: string,
    memberId: string,
    input: ActionPublishInput,
    caller: string,
  ): Promise<ActionToolOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could show it',
      'publish an action',
      (sink) => sink.publish(input, caller),
    );
  }

  async remove(
    runId: string,
    memberId: string,
    actionId: string,
    caller: string,
  ): Promise<ActionToolOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could remove it',
      'remove an action',
      (sink) => sink.remove(actionId, caller),
    );
  }
}
