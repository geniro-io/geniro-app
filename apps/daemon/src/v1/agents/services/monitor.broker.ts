import { Injectable } from '@nestjs/common';

import type {
  MonitorListing,
  MonitorStartInput,
  MonitorStartOutcome,
  MonitorStopOutcome,
} from '../chat.types';
import type { MonitorOwner } from '../chat.types';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';
import { MonitorRegistry } from './monitor.registry';

/**
 * What a member's turn tells the monitor tools: whose a monitor started by
 * `caller` is, and the folder it runs in. `caller` is the MCP call's caller
 * key, never the model's word, so a callee conversation's monitor is its own.
 */
export interface MonitorSink {
  ownerOf(caller: string): { owner: MonitorOwner; cwd: string };
}

/**
 * The `monitor`, `stop_monitor` and `list_monitors` tools' way in. A member is
 * offered them only while its turn has registered a sink — and the turn
 * registers one only where the call is put to the user first or the mode is
 * `auto` (`AdapterConfig.hostToolCallUngatedReason`), since the command runs
 * in no sandbox of its own.
 */
@Injectable()
export class MonitorBroker extends HostSinkBroker<MonitorSink> {
  constructor(private readonly monitors: MonitorRegistry) {
    super();
  }

  /** Whether this member is offered the monitor tools right now. */
  canMonitor(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  start(
    runId: string,
    memberId: string,
    input: MonitorStartInput,
    caller: string,
  ): Promise<MonitorStartOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could own it',
      'start a monitor',
      (sink) => {
        const { owner, cwd } = sink.ownerOf(caller);
        return Promise.resolve(
          this.monitors.start({
            owner,
            cwd,
            command: input.command,
            description: input.description,
            timeoutMs: input.timeoutMs,
          }),
        );
      },
    );
  }

  stop(
    runId: string,
    memberId: string,
    id: string,
    caller: string,
  ): Promise<MonitorStopOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could stop it',
      'stop a monitor',
      () => Promise.resolve(this.monitors.stop(runId, id, 'agent', caller)),
    );
  }

  list(
    runId: string,
    memberId: string,
    caller: string,
  ): Promise<MonitorListing[] | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could list them',
      'list monitors',
      () =>
        Promise.resolve(
          this.monitors
            .list(runId, caller)
            .map(({ owner: _owner, ...listing }) => listing),
        ),
    );
  }
}
