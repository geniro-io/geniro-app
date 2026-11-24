import { Injectable } from '@nestjs/common';

import type { HostUiCall, HostUiOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

export type SurfaceDrawer = (
  call: HostUiCall,
  caller: string,
  stop: AbortSignal,
) => Promise<HostUiOutcome>;

@Injectable()
export class SurfaceBroker extends HostSinkBroker<SurfaceDrawer> {
  canDraw(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  async draw(
    runId: string,
    memberId: string,
    call: HostUiCall,
    caller: string,
    stop: AbortSignal,
  ): Promise<HostUiOutcome> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could show it',
      'show a card',
      (drawer) => drawer(call, caller, stop),
    );
  }
}
