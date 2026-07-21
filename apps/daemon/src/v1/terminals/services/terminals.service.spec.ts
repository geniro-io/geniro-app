import { describe, expect, it, vi } from 'vitest';

import { TerminalsService } from './terminals.service';

function build(overrides: {
  run?: Record<string, unknown> | null;
  nodeState?: { agentSessionId: string | null } | null;
  workflow?: {
    nodes: { id: string; kind?: string; agent?: string }[];
  };
}) {
  const runDao = { getById: vi.fn().mockResolvedValue(overrides.run ?? null) };
  const nodeStateDao = {
    getByRunNode: vi
      .fn()
      .mockResolvedValue(
        'nodeState' in overrides
          ? overrides.nodeState
          : { agentSessionId: 'sess-default' },
      ),
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

  it('re-injects the inherited Anthropic credential for the claude-only mirror', async () => {
    // buildChildEnv strips the credential from every child; the terminal
    // mirror is definitionally claude (terminalCommand rejects cursor), so
    // the create input must carry the re-injection or every `claude --resume`
    // mirror silently de-authenticates.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-terminal';
    try {
      const { service, pty } = build({
        run: CHAT_RUN,
        nodeState: { agentSessionId: 'sess-9' },
      });

      await service.createForRun({ runId: 'run-1' });

      expect(pty.create).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: 'sk-ant-terminal',
          }),
        }),
      );
    } finally {
      if (saved === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = saved;
      }
    }
  });

  it('rejects until the run has a resumable CLI session id', async () => {
    const { service, pty } = build({ run: CHAT_RUN, nodeState: null });

    await expect(service.createForRun({ runId: 'run-1' })).rejects.toThrow(
      /TERMINAL_SESSION_UNAVAILABLE|resumable terminal session/,
    );

    expect(pty.create).not.toHaveBeenCalled();
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

  it('rejects workflow trigger and cursor-agent nodes', async () => {
    const trigger = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'start', kind: 'trigger' }] },
    });
    await expect(
      trigger.service.createForRun({ runId: 'run-2', nodeId: 'start' }),
    ).rejects.toThrow(/TERMINAL_NODE_NOT_AGENT|only agent nodes/);

    const cursor = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: {
        nodes: [{ id: 'cursor', kind: 'agent', agent: 'cursor-agent' }],
      },
    });
    await expect(
      cursor.service.createForRun({ runId: 'run-2', nodeId: 'cursor' }),
    ).rejects.toThrow(/TERMINAL_UNSUPPORTED|no interactive terminal/);
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

  it('an explicit sessionId mirrors THAT thread instead of node_state', async () => {
    const { service, pty, nodeStateDao } = build({
      run: { id: 'run-1', workflowId: 'wf', cwd: '/tmp' },
      nodeState: { agentSessionId: 'sess-latest' },
      workflow: { nodes: [{ id: 'n1', kind: 'agent', agent: 'claude' }] },
    });

    await service.createForRun({
      runId: 'run-1',
      nodeId: 'n1',
      sessionId: 'sess-call-7',
    });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--resume', 'sess-call-7'],
        resumeSessionId: 'sess-call-7',
      }),
    );
    // node_state (the node's LATEST session) must not even be consulted.
    expect(nodeStateDao.getByRunNode).not.toHaveBeenCalled();
    expect(pty.findRunning).toHaveBeenCalledWith('run-1', 'n1', 'sess-call-7');
  });

  it('distinct thread sessions are distinct targets — concurrent creates both spawn', async () => {
    const { service, pty } = build({
      run: { id: 'run-1', workflowId: 'wf', cwd: '/tmp' },
      workflow: { nodes: [{ id: 'n1', kind: 'agent', agent: 'claude' }] },
    });

    const [a, b] = await Promise.all([
      service.createForRun({ runId: 'run-1', nodeId: 'n1', sessionId: 's-1' }),
      service.createForRun({ runId: 'run-1', nodeId: 'n1', sessionId: 's-2' }),
    ]);

    expect(pty.create).toHaveBeenCalledTimes(2);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects a nodeId alias for a chat terminal target', async () => {
    const { service, pty } = build({ run: CHAT_RUN });

    const [canonical, aliased] = await Promise.allSettled([
      service.createForRun({ runId: 'run-1' }),
      service.createForRun({ runId: 'run-1', nodeId: 'ignored-chat-node' }),
    ]);

    expect(canonical.status).toBe('fulfilled');
    expect(aliased.status).toBe('rejected');
    expect(String(aliased.status === 'rejected' ? aliased.reason : '')).toMatch(
      /TERMINAL_NODE_UNEXPECTED|does not accept a nodeId/,
    );
    expect(pty.create).toHaveBeenCalledTimes(1);
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
