import { Injectable, type OnModuleInit } from '@nestjs/common';

import { AgentActivityService } from '../../agents/services/agent-activity.service';
import { RunLiveWork } from '../../agents/services/run-live-work.service';
import { CallBroker } from './call-broker.service';
import { HostWakeGraphDelivery } from './host-wake-graph-delivery.service';
import { MonitorGraphDelivery } from './monitor-graph-delivery.service';
import { TeamExecutorService } from './team-executor.service';

/**
 * A team run's own work outside a turn, as {@link RunLiveWork} counts it, and
 * its blocked conversations, as {@link AgentActivityService} reads them.
 */
@Injectable()
export class TeamLiveWorkSources implements OnModuleInit {
  constructor(
    private readonly liveWork: RunLiveWork,
    private readonly executor: TeamExecutorService,
    private readonly monitorOutput: MonitorGraphDelivery,
    private readonly hostWakes: HostWakeGraphDelivery,
    private readonly activity: AgentActivityService,
    private readonly calls: CallBroker,
  ) {}

  onModuleInit(): void {
    this.activity.useBlockedConversations((runId) =>
      this.calls.blockedConversations(runId),
    );
    this.liveWork.register('team background work', (runId) =>
      this.executor.holdsBackgroundWork(runId),
    );
    this.liveWork.register('team monitor output', (runId) =>
      this.monitorOutput.owesOutput(runId),
    );
    this.liveWork.register('team host wake', (runId) =>
      this.hostWakes.owesWake(runId),
    );
  }
}
