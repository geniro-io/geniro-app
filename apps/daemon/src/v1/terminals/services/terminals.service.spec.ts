import { describe, expect, it, vi } from 'vitest';

import { TerminalsService } from './terminals.service';

function build(overrides: {
  run?: Record<string, unknown> | null;
  nodeState?: { agentSessionId: string | null } | null;
  workflow?: { nodes: { id: string; agent: string }[] };
}) {
  const runDao = { getById: vi.fn().mockResolvedValue(overrides.run ?? null) };
  const nodeStateDao = {
    getByRunNode: vi.fn().mockResolvedValue(overrides.nodeState ?? null),
  };
  const workflowStore = {
    get: vi.fn().mockResolvedValue({
      slug: 'wf',
      workflow: overrides.workflow ?? { nodes: [] },
    }),
  };
  // Per-call unique ids: with a hardcoded id, the single-flight assertion
  // `a.id === b.id` would hold even with the guard deleted (a false pin).
  let ptySeq = 0;
  const pty = {
    findRunning: vi.fn().mockReturnValue(null),
    create: vi.fn((input: Record<string, unknown>) => ({
      id: `t-${ptySeq++}`,
      runId: input.runId,
      nodeId: input.nodeId,
      cwd: input.cwd,
      status: 'running',
      exitCode: null,
      createdAt: 0,
    })),
  };
  const em = { fork: () => ({}) };
  const service = new TerminalsService(
    em as never,
    runDao as never,
    nodeStateDao as never,
    workflowStore as never,
    pty as never,
  );
  return { service, runDao, nodeStateDao, workflowStore, pty };
}

const CHAT_RUN = {
  id: 'run-1',
  workflowId: null,
  agentKind: 'claude',
  cwd: '/tmp',
};

describe('TerminalsService', () => {
  it('opens a chat-run terminal resuming the stored CLI session', async () => {
    const { service, pty, nodeStateDao } = build({
      run: CHAT_RUN,
      nodeState: { agentSessionId: 'sess-9' },
    });

    const wire = await service.createForRun({ runId: 'run-1' });

    expect(nodeStateDao.getByRunNode).toHaveBeenCalledWith(
      'run-1',
      'agent',
      expect.anything(),
    );
    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'claude',
        args: ['--resume', 'sess-9'],
        nodeId: null,
      }),
    );
    expect(wire.status).toBe('running');
  });

  it('opens a fresh session when no CLI session id is stored', async () => {
    const { service, pty } = build({ run: CHAT_RUN, nodeState: null });

    await service.createForRun({ runId: 'run-1' });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'claude', args: [] }),
    );
  });

  it('resolves a workflow node agent from the YAML definition', async () => {
    const { service, pty } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      nodeState: { agentSessionId: 'sess-n' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });

    await service.createForRun({ runId: 'run-2', nodeId: 'agent-1' });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'agent-1',
        args: ['--resume', 'sess-n'],
      }),
    );
  });

  it('requires nodeId for a workflow run', async () => {
    const { service } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
    });

    await expect(service.createForRun({ runId: 'run-2' })).rejects.toThrow(
      /TERMINAL_NODE_REQUIRED|workflow run/,
    );
  });

  it('rejects an unknown workflow node', async () => {
    const { service } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });

    await expect(
      service.createForRun({ runId: 'run-2', nodeId: 'nope' }),
    ).rejects.toThrow(/NODE_NOT_FOUND|no node/);
  });

  it('returns the existing running session instead of spawning a duplicate', async () => {
    const { service, pty } = build({ run: CHAT_RUN });
    pty.findRunning.mockReturnValue({
      id: 't-existing',
      runId: 'run-1',
      nodeId: null,
      cwd: '/tmp',
      status: 'running',
      exitCode: null,
      createdAt: 0,
    });

    const wire = await service.createForRun({ runId: 'run-1' });

    expect(wire.id).toBe('t-existing');
    expect(pty.create).not.toHaveBeenCalled();
  });

  it('coalesces concurrent creates for the same (run, node) onto one spawn', async () => {
    const { service, pty } = build({ run: CHAT_RUN });

    // Fire both BEFORE awaiting: each would pass findRunning (nothing spawned
    // yet), so only the single-flight map prevents a double spawn.
    const [a, b] = await Promise.all([
      service.createForRun({ runId: 'run-1' }),
      service.createForRun({ runId: 'run-1' }),
    ]);

    expect(pty.create).toHaveBeenCalledTimes(1);
    expect(a.id).toBe(b.id);
  });

  it('rejects a chat run that lost its agent kind', async () => {
    const { service } = build({ run: { ...CHAT_RUN, agentKind: null } });

    await expect(service.createForRun({ runId: 'run-1' })).rejects.toThrow(
      /TERMINAL_NO_AGENT|no agent kind/,
    );
  });

  it('rejects a missing run and a run without cwd', async () => {
    const missing = build({ run: null });
    await expect(
      missing.service.createForRun({ runId: 'gone' }),
    ).rejects.toThrow(/RUN_NOT_FOUND|no run/);

    const noCwd = build({ run: { ...CHAT_RUN, cwd: null } });
    await expect(
      noCwd.service.createForRun({ runId: 'run-1' }),
    ).rejects.toThrow(/TERMINAL_NO_CWD|working directory/);
  });
});
