import { describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { TerminalsService } from './terminals.service';

function build(overrides: {
  run?: Record<string, unknown> | null;
  nodeState?: {
    agentSessionId: string | null;
    agentKind?: string;
    /** The stamped model an interactive mirror reopens on. */
    model?: string;
  } | null;
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
    killRun: vi.fn().mockReturnValue(0),
    refreshTarget: vi.fn(),
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
  const bus = new AgentEventBus();
  // The REAL adapters: the mirror invocation is now each CLI's own
  // `terminalCommand`, so a double here would assert against a fake argv.
  const adapters = new AgentAdapterRegistry(
    new ClaudeAdapter(),
    new CursorAcpAdapter(),
  );
  const service = new TerminalsService(
    em as never,
    runDao as never,
    nodeStateDao as never,
    workflowStore as never,
    pty as never,
    adapters,
    bus,
  );
  return { service, runDao, nodeStateDao, workflowStore, pty, bus };
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

    const wire = await service.createForRun({
      runId: 'run-1',
    });

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

  it('opens the mirror on the run’s OWN model, not the CLI default', async () => {
    // A mirror that resumed under claude's default was a different model with
    // a different context window sitting beside the chat it mirrors — which is
    // what put a 200k readout next to a 1M-window conversation.
    const { service, pty } = build({
      run: { ...CHAT_RUN, model: 'claude-opus-5[1m]' },
      nodeState: { agentSessionId: 'sess-9' },
    });

    await service.createForRun({ runId: 'run-1' });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--model', 'claude-opus-5[1m]', '--resume', 'sess-9'],
      }),
    );
  });

  it('re-injects the inherited Anthropic credential for the claude-only mirror', async () => {
    // buildChildEnv strips the credential from every child; the terminal
    // mirror is definitionally claude (cursor's adapter answers unsupported), so
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

  it('resolves a LEGACY (unstamped) workflow node agent from the YAML definition', async () => {
    const { service, pty } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      nodeState: { agentSessionId: 'sess-n' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });

    await service.createForRun({
      runId: 'run-2',
      nodeId: 'agent-1',
    });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'agent-1',
        args: ['--resume', 'sess-n'],
      }),
    );
  });

  it('resolves a stamped node from run history even after the node left the workflow YAML', async () => {
    // F39: run history must not depend on the live library definition —
    // deleting (or re-agenting) a node after runs exist previously broke its
    // past runs' terminals. The stamped agent_kind row is the record.
    const { service, pty, workflowStore } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      nodeState: {
        agentSessionId: 'sess-n',
        agentKind: 'claude',
        model: 'claude-opus-5[1m]',
      },
      workflow: { nodes: [] },
    });

    await service.createForRun({
      runId: 'run-2',
      nodeId: 'agent-1',
    });

    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'agent-1',
        command: 'claude',
        // The MODEL comes from the stamp too — reading the current YAML would
        // re-write what a finished run actually ran as, which is the drift the
        // stamp exists to prevent.
        args: ['--model', 'claude-opus-5[1m]', '--resume', 'sess-n'],
      }),
    );
    // The stamp fully replaces the YAML lookup — the current definition is
    // never consulted for a stamped historical node.
    expect(workflowStore.get).not.toHaveBeenCalled();
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
      service.createForRun({
        runId: 'run-2',
        nodeId: 'nope',
      }),
    ).rejects.toThrow(/NODE_NOT_FOUND|no node/);
  });

  it('rejects workflow trigger and cursor-agent nodes', async () => {
    const trigger = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'start', kind: 'trigger' }] },
    });
    await expect(
      trigger.service.createForRun({
        runId: 'run-2',
        nodeId: 'start',
      }),
    ).rejects.toThrow(/TERMINAL_NODE_NOT_AGENT|only agent nodes/);

    const cursor = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: {
        nodes: [{ id: 'cursor', kind: 'agent', agent: 'cursor-agent' }],
      },
    });
    await expect(
      cursor.service.createForRun({
        runId: 'run-2',
        nodeId: 'cursor',
      }),
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

    const wire = await service.createForRun({
      runId: 'run-1',
    });

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
    const { service, pty } = build({
      run: { id: 'run-1', workflowId: 'wf', cwd: '/tmp' },
      nodeState: { agentSessionId: 'sess-latest' },
      workflow: { nodes: [{ id: 'n1', kind: 'agent', agent: 'claude' }] },
    });

    await service.createForRun({
      runId: 'run-1',
      nodeId: 'n1',
      sessionId: 'sess-call-7',
    });

    // The node_state row is still read (its agent_kind stamp resolves the
    // CLI), but its LATEST session id must never displace the named thread.
    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--resume', 'sess-call-7'],
        resumeSessionId: 'sess-call-7',
      }),
    );
    expect(pty.findRunning).toHaveBeenCalledWith('run-1', 'n1', 'sess-call-7');
  });

  it('distinct thread sessions are distinct targets — concurrent creates both spawn', async () => {
    const { service, pty } = build({
      run: { id: 'run-1', workflowId: 'wf', cwd: '/tmp' },
      workflow: { nodes: [{ id: 'n1', kind: 'agent', agent: 'claude' }] },
    });

    const [a, b] = await Promise.all([
      service.createForRun({
        runId: 'run-1',
        nodeId: 'n1',
        sessionId: 's-1',
      }),
      service.createForRun({
        runId: 'run-1',
        nodeId: 'n1',
        sessionId: 's-2',
      }),
    ]);

    expect(pty.create).toHaveBeenCalledTimes(2);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects a nodeId alias for a chat terminal target', async () => {
    const { service, pty } = build({ run: CHAT_RUN });

    const [canonical, aliased] = await Promise.allSettled([
      service.createForRun({ runId: 'run-1' }),
      service.createForRun({
        runId: 'run-1',
        nodeId: 'ignored-chat-node',
      }),
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

describe('TerminalsService — a deleted run takes its mirrors with it', () => {
  it('kills the run’s live mirrors when the run is deleted', () => {
    // A mirror of a deleted run would keep a `claude --resume` child alive
    // against a transcript that no longer exists. The chat service cannot
    // call TerminalSessionsService (its module sits below this one), so the signal is a
    // subscription — deleting the subscription must break this test.
    const { pty, bus } = build({ run: null });
    pty.killRun.mockReturnValue(2);
    bus.publishRunDeleted('run-gone');
    expect(pty.killRun).toHaveBeenCalledWith('run-gone');
  });

  it('stops listening once the daemon shuts down', () => {
    const { service, pty, bus } = build({ run: null });
    service.onApplicationShutdown();
    bus.publishRunDeleted('run-gone');
    expect(pty.killRun).not.toHaveBeenCalled();
  });
});

describe('TerminalsService — transcript growth refreshes the mirror', () => {
  /** One transcript item as the bus carries it. */
  const item = (
    kind: string,
    nodeId: string | null,
    payload: unknown = null,
  ) => ({
    id: 'i1',
    runId: 'run-1',
    nodeId,
    seq: 1,
    kind,
    role: null,
    payload,
    createdAt: 'now',
  });

  it('refreshes a chat mirror when the chat’s turn completes', () => {
    // The whole point: the CLI reads its transcript at startup and never again,
    // so without this the mirror shows the conversation as it was when the
    // panel opened — the "cli is not in sync, I can't see the question" report.
    const { pty, bus } = build({ run: null });

    bus.publish({ runId: 'run-1', item: item('turn_complete', null) as never });

    expect(pty.refreshTarget).toHaveBeenCalledWith('run-1', null, {
      immediate: true,
    });
  });

  it('refreshes a workflow node’s mirror when THAT node settles', () => {
    // A workflow's own `turn_complete` arrives once, for the whole graph, with
    // no node id — treating it as a node's settle would leave every node's
    // mirror stale for the entire run.
    const { pty, bus } = build({ run: null });

    bus.publish({
      runId: 'run-1',
      item: item('status', 'worker', { status: 'completed' }) as never,
    });

    expect(pty.refreshTarget).toHaveBeenCalledWith('run-1', 'worker', {
      immediate: true,
    });
  });

  it('refreshes DURING a turn too, but without the settle’s urgency', () => {
    // The reported bug: this used to fire only on a settled turn, so a mirror
    // opened during a long turn stayed frozen for the whole of it. The CLI
    // appends to its transcript as it works (probe-measured: a 34s turn grew
    // 11 → 25 lines), so every item means there is more to read. The session
    // layer is what keeps the cost down — this side must not filter items out.
    const { pty, bus } = build({ run: null });

    bus.publish({
      runId: 'run-1',
      item: item('status', 'worker', { status: 'running' }) as never,
    });
    bus.publish({ runId: 'run-1', item: item('message', null) as never });

    expect(pty.refreshTarget).toHaveBeenNthCalledWith(1, 'run-1', 'worker', {
      immediate: false,
    });
    expect(pty.refreshTarget).toHaveBeenNthCalledWith(2, 'run-1', null, {
      immediate: false,
    });
  });

  it('stops refreshing once the daemon shuts down', () => {
    const { service, pty, bus } = build({ run: null });
    service.onApplicationShutdown();

    bus.publish({ runId: 'run-1', item: item('turn_complete', null) as never });

    expect(pty.refreshTarget).not.toHaveBeenCalled();
  });
});
