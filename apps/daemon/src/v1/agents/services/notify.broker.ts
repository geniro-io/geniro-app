import { Injectable } from '@nestjs/common';

import type { HostNotifyOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Sends the agent's own notification (`HOST_NOTIFY_TOOL`) to the user.
 *
 * A rendezvous and nothing more — the mechanics live in {@link HostSinkBroker}.
 * Fire-and-forget: the agent is not waiting on a person, and nothing is
 * written, so the only way a send can fail is that no turn is running.
 */
export type Notifier = (message: string) => Promise<HostNotifyOutcome>;

@Injectable()
export class NotifyBroker extends HostSinkBroker<Notifier> {
  /** Whether this node can currently notify — gates the tool listing. */
  canNotify(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Send the notification and resolve with what happened. Never throws. */
  async notify(
    runId: string,
    nodeId: string,
    message: string,
  ): Promise<HostNotifyOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could send it',
      'send a notification',
      (notifier) => notifier(message),
    );
  }
}
