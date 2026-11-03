import { describe, expect, it, vi } from 'vitest';

import {
  AgentActivityService,
  DETACHED_WORK_MS,
} from './agent-activity.service';
import type { AgentSessionRegistry } from './agent-session.registry';
import { ApprovalRegistry, type PendingApproval } from './approval-registry';
import { ProcessRegistry } from './process-registry';

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    runId: 'run-1',
    memberId: 'n1',
    requestId: 'req-1',
    toolName: 'Bash',
    input: {},
    question: false,
    respond: vi.fn(() => true),
    ...over,
  };
}

function setup(): {
  service: AgentActivityService;
  processes: ProcessRegistry;
  approvals: ApprovalRegistry;
  betweenTurns: ReturnType<typeof vi.fn>;
  turns: { inFlight: number };
} {
  const processes = new ProcessRegistry();
  const approvals = new ApprovalRegistry();
  const betweenTurns = vi.fn((_detachedForMs: number) => false);
  const turns = { inFlight: 1 };
  const service = new AgentActivityService(
    processes,
    {
      worksBetweenTurns: betweenTurns,
      turnsInFlight: () => turns.inFlight,
    } as unknown as AgentSessionRegistry,
    approvals,
  );
  return { service, processes, approvals, betweenTurns, turns };
}

describe('AgentActivityService', () => {
  it('is not working with nothing claimed and nothing between turns', () => {
    const { service } = setup();

    expect(service.working).toBe(false);
  });

  it("is working from the moment a run's turn is claimed until it is released", () => {
    const { service, processes } = setup();

    processes.tryClaim('run-1');
    expect(service.working).toBe(true);

    processes.release('run-1');
    expect(service.working).toBe(false);
  });

  it('does not count a turn that waits on the user, and counts it again once answered', () => {
    const { service, processes, approvals } = setup();
    processes.tryClaim('run-1');

    approvals.track(pending({ question: true }));
    expect(service.working).toBe(false);

    approvals.resolve('run-1', 'req-1', true);
    expect(service.working).toBe(true);
  });

  it('does not read a standing card as the turn the next message opened waiting', () => {
    const { service, processes, approvals } = setup();
    processes.tryClaim('run-1');

    approvals.track(pending({ standing: true }));

    expect(service.working).toBe(true);
  });

  it('counts a team run working while one member waits and another works, not once both wait', () => {
    const { service, processes, approvals, turns } = setup();
    processes.tryClaim('run-1');
    turns.inFlight = 2;

    approvals.track(pending({ memberId: 'a', requestId: 'req-a' }));
    expect(service.working).toBe(true);

    approvals.track(pending({ memberId: 'b', requestId: 'req-b' }));
    expect(service.working).toBe(false);
  });

  it("takes a team run's blocked conversations from the team module over its cards", () => {
    const { service, processes, approvals, turns } = setup();
    processes.tryClaim('run-1');
    turns.inFlight = 2;
    approvals.track(pending({ memberId: 'callee' }));
    const blocked = { count: 1 };
    service.useBlockedConversations((runId) =>
      runId === 'run-1' ? blocked.count : null,
    );

    expect(service.working).toBe(true);

    blocked.count = 2;
    expect(service.working).toBe(false);
  });

  it('counts another run working while one waits on the user', () => {
    const { service, processes, approvals } = setup();
    processes.tryClaim('run-1');
    processes.tryClaim('run-2');

    approvals.track(pending());

    expect(service.working).toBe(true);
  });

  it("counts a monitor and a command action, never the daemon's own errands", () => {
    const { service, processes } = setup();

    processes.tryClaim('models:version:abc');
    processes.tryClaim('claude-probe:auto:abc');
    expect(service.working).toBe(false);

    processes.tryClaim('monitor:run-1:m1');
    expect(service.working).toBe(true);
    processes.release('monitor:run-1:m1');

    processes.tryClaim('action:run-1:abc');
    expect(service.working).toBe(true);
  });

  it('counts work between turns, asking for detached commands within the hour', () => {
    const { service, betweenTurns } = setup();

    betweenTurns.mockReturnValue(true);

    expect(service.working).toBe(true);
    expect(betweenTurns).toHaveBeenCalledWith(DETACHED_WORK_MS);
    expect(DETACHED_WORK_MS).toBe(60 * 60_000);
  });
});
