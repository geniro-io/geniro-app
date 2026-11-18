import { describe, expect, it } from 'vitest';

import type { AgentActivityService } from '../../agents/services/agent-activity.service';
import type {
  RunLiveWork,
  RunLiveWorkSource,
} from '../../agents/services/run-live-work.service';
import type { CallBroker } from './call-broker.service';
import type { HostWakeGraphDelivery } from './host-wake-graph-delivery.service';
import type { MonitorGraphDelivery } from './monitor-graph-delivery.service';
import type { TeamExecutorService } from './team-executor.service';
import { TeamLiveWorkSources } from './team-live-work.service';

describe('TeamLiveWorkSources', () => {
  it('holds a run whose executor took a wake that has not opened its turn yet', () => {
    const sources = new Map<string, RunLiveWorkSource>();
    const opening = new Set<string>(['run-1']);
    const team = new TeamLiveWorkSources(
      {
        register: (name: string, source: RunLiveWorkSource) => {
          sources.set(name, source);
          return () => undefined;
        },
      } as unknown as RunLiveWork,
      {
        holdsBackgroundWork: () => false,
        holdsOpeningWake: (runId: string) => opening.has(runId),
      } as unknown as TeamExecutorService,
      { owesOutput: () => false } as unknown as MonitorGraphDelivery,
      { owesWake: () => false } as unknown as HostWakeGraphDelivery,
      {
        useBlockedConversations: () => undefined,
      } as unknown as AgentActivityService,
      { blockedConversations: () => 0 } as unknown as CallBroker,
    );

    team.onModuleInit();
    const held = (runId: string): boolean =>
      [...sources.values()].some((source) => source(runId));

    expect(held('run-1')).toBe(true);
    expect(held('run-2')).toBe(false);
    opening.delete('run-1');
    expect(held('run-1')).toBe(false);
  });
});
