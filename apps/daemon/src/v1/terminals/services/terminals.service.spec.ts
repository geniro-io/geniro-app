import type { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { TurnMirrorService } from '../../agents/services/turn-mirror.service';
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
    createMirror: vi.fn((input: Record<string, unknown>) => ({
      id: `m-${ptySeq++}`,
      kind: 'live',
      runId: input.runId,
      nodeId: input.nodeId,
      resumeSessionId: null,
      cwd: input.cwd,
      snapshot: input.snapshot,
      status: 'running',
      exitCode: null,
      createdAt: 0,
    })),
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
  const mirrors = new TurnMirrorService();
  const service = new TerminalsService(
    em as never,
    runDao as never,
    nodeStateDao as never,
    workflowStore as never,
    pty as never,
    adapters,
    mirrors,
    bus,
  );
  return { service, runDao, nodeStateDao, workflowStore, pty, bus, mirrors };
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
      kind: 'interactive',
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

    await service.createForRun({ kind: 'interactive', runId: 'run-1' });

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

      await service.createForRun({ kind: 'interactive', runId: 'run-1' });

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

    await expect(
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
    ).rejects.toThrow(
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
      kind: 'interactive',
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
      kind: 'interactive',
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

    await expect(
      service.createForRun({ kind: 'interactive', runId: 'run-2' }),
    ).rejects.toThrow(/TERMINAL_NODE_REQUIRED|workflow run/);
  });

  it('rejects an unknown workflow node', async () => {
    const { service } = build({
      run: { id: 'run-2', workflowId: 'demo', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });

    await expect(
      service.createForRun({
        kind: 'interactive',
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
        kind: 'interactive',
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
        kind: 'interactive',
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
      kind: 'interactive',
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
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
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
      kind: 'interactive',
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
    expect(pty.findRunning).toHaveBeenCalledWith(
      'interactive',
      'run-1',
      'n1',
      'sess-call-7',
    );
  });

  it('distinct thread sessions are distinct targets — concurrent creates both spawn', async () => {
    const { service, pty } = build({
      run: { id: 'run-1', workflowId: 'wf', cwd: '/tmp' },
      workflow: { nodes: [{ id: 'n1', kind: 'agent', agent: 'claude' }] },
    });

    const [a, b] = await Promise.all([
      service.createForRun({
        kind: 'interactive',
        runId: 'run-1',
        nodeId: 'n1',
        sessionId: 's-1',
      }),
      service.createForRun({
        kind: 'interactive',
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
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
      service.createForRun({
        kind: 'interactive',
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

    await expect(
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
    ).rejects.toThrow(/TERMINAL_NO_AGENT|no agent kind/);
  });

  it('rejects a missing run and a run without cwd', async () => {
    const missing = build({ run: null });
    await expect(
      missing.service.createForRun({ kind: 'interactive', runId: 'gone' }),
    ).rejects.toThrow(/RUN_NOT_FOUND|no run/);

    const noCwd = build({ run: { ...CHAT_RUN, cwd: null } });
    await expect(
      noCwd.service.createForRun({ kind: 'interactive', runId: 'run-1' }),
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

describe('TerminalsService — the live mirror', () => {
  it('is the default, and hands the PTY layer the node’s buffered output', async () => {
    const { service, mirrors, pty } = build({ run: CHAT_RUN });
    // What the chat's own turn wrote, under the single-agent node key.
    mirrors.sink('run-1', SINGLE_AGENT_NODE).data('stdout', 'from the turn');

    // No `kind` at all — the default is what a terminal button reaches.
    const wire = await service.createForRun({ runId: 'run-1' });

    expect(wire.kind).toBe('live');
    expect(pty.create).not.toHaveBeenCalled();
    expect(pty.createMirror).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        nodeId: null,
        snapshot: 'from the turn',
      }),
    );

    // The `source` channel too, not just the replayed snapshot: pointed at the
    // wrong key it would replay history perfectly and then never update, which
    // is precisely the bug this feature exists to fix.
    const arg = pty.createMirror.mock.calls[0]?.[0] as {
      source: Observable<string>;
    };
    const live: string[] = [];
    arg.source.subscribe((chunk) => live.push(chunk));
    mirrors.sink('run-1', SINGLE_AGENT_NODE).data('stdout', 'a later chunk');
    expect(live).toContain('a later chunk');
  });

  it('opens for cursor-agent, which has no interactive mirror at all', async () => {
    // The live mirror is raw bytes off whichever CLI ran the turn, so it needs
    // neither `terminalCommand` support nor a resumable session. Asking for the
    // interactive one still refuses, which is what makes this a real gain
    // rather than a relabelling.
    const cursorRun = { ...CHAT_RUN, agentKind: 'cursor-agent' };
    const { service } = build({ run: cursorRun });

    await expect(service.createForRun({ runId: 'run-1' })).resolves.toEqual(
      expect.objectContaining({ kind: 'live' }),
    );
    await expect(
      service.createForRun({ kind: 'interactive', runId: 'run-1' }),
    ).rejects.toThrow(/TERMINAL_UNSUPPORTED|no interactive terminal/);
  });

  it('opens without a resumable session, and without a cwd', async () => {
    // Both are `--resume` spawn requirements. A live mirror runs nothing, so a
    // brand-new chat gets a terminal that fills in as its first turn runs.
    const { service } = build({
      run: { ...CHAT_RUN, cwd: null },
      nodeState: null,
    });

    await expect(service.createForRun({ runId: 'run-1' })).resolves.toEqual(
      expect.objectContaining({ kind: 'live' }),
    );
  });

  it('re-attaches to an open mirror instead of opening a second one', async () => {
    const { service, pty } = build({ run: CHAT_RUN });
    pty.findRunning.mockReturnValue({ id: 'already-open', kind: 'live' });

    const wire = await service.createForRun({ runId: 'run-1' });

    expect(wire.id).toBe('already-open');
    expect(pty.createMirror).not.toHaveBeenCalled();
    expect(pty.findRunning).toHaveBeenCalledWith('live', 'run-1', null);
  });

  it('still demands a nodeId on a workflow run — a mirror follows ONE node', async () => {
    const { service } = build({
      run: { id: 'run-2', workflowId: 'wf', agentKind: null, cwd: '/tmp' },
    });

    await expect(service.createForRun({ runId: 'run-2' })).rejects.toThrow(
      /TERMINAL_NODE_REQUIRED|workflow run/,
    );
  });

  it('reads a workflow node’s own buffer, not the chat constant', async () => {
    const { service, mirrors, pty } = build({
      run: { id: 'run-2', workflowId: 'wf', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });
    mirrors.sink('run-2', 'agent-1').data('stdout', 'node output');

    await service.createForRun({ runId: 'run-2', nodeId: 'agent-1' });

    expect(pty.createMirror).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'agent-1', snapshot: 'node output' }),
    );
  });
});

describe('TerminalsService — a live mirror still validates its node', () => {
  it('rejects an unknown node instead of opening a buffer for it', async () => {
    // Opening a mirror CREATES its buffer, and buffers evict least-recently
    // touched. Accepting any string as a node id would let a caller age out a
    // run's real turn history by opening mirrors on nodes that do not exist.
    const { service, mirrors, pty } = build({
      run: { id: 'run-2', workflowId: 'wf', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'agent-1', kind: 'agent', agent: 'claude' }] },
    });
    mirrors.sink('run-2', 'agent-1').data('stdout', 'real history');

    await expect(
      service.createForRun({ runId: 'run-2', nodeId: 'does-not-exist' }),
    ).rejects.toThrow(/NODE_NOT_FOUND|no node/);

    expect(pty.createMirror).not.toHaveBeenCalled();
    // And the junk id left no buffer behind to press on the ceiling.
    expect(mirrors.snapshot('run-2', 'does-not-exist')).toBe('');
    expect(mirrors.snapshot('run-2', 'agent-1')).toBe('real history');
  });

  it('rejects a trigger node — only agent nodes run anything to mirror', async () => {
    const { service } = build({
      run: { id: 'run-2', workflowId: 'wf', agentKind: null, cwd: '/tmp' },
      workflow: { nodes: [{ id: 'start', kind: 'trigger' }] },
    });

    await expect(
      service.createForRun({ runId: 'run-2', nodeId: 'start' }),
    ).rejects.toThrow(/TERMINAL_NODE_NOT_AGENT|only agent nodes/);
  });
});
