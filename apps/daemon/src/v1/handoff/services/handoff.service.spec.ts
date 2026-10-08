import { describe, expect, it, vi } from 'vitest';

import type {
  AdapterConfig,
  HandoffResult,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { AgentKind } from '../../runs/runs.types';
import { HandoffService } from './handoff.service';

/**
 * The service reaches four collaborators and its own job is small: pick the
 * agent, ask its adapter, and shape the answer. Doubles keep the test on that.
 */
function build(
  overrides: {
    run?: Record<string, unknown> | null;
    target?: HandoffResult;
    adapter?: AgentAdapter;
    handoffConfig?: AdapterConfig['handoff'];
    sessionId?: string | null;
    /** Registry keys holding a live process. */
    live?: string[];
    /** The agent kind stamped on a workflow node's state row. */
    nodeAgentKind?: AgentKind;
    /** The run's `call_started` / `call_result` rows. */
    callRows?: { kind: string; payload: unknown }[];
  } = {},
) {
  const live = new Set(overrides.live ?? []);
  const run =
    overrides.run === undefined
      ? {
          id: 'run-1',
          workflowId: null,
          agentKind: AgentKind.Claude,
          model: null,
          cwd: process.cwd(),
        }
      : overrides.run;
  const handoffTarget = vi.fn(
    (): HandoffResult =>
      overrides.target ?? {
        ok: true,
        kind: 'command',
        command: 'claude',
        args: ['--resume', 'sess-1'],
        env: {},
      },
  );
  const handoffConfig: AdapterConfig['handoff'] = overrides.handoffConfig ?? {
    kind: 'resume-command' as const,
    resumeFlag: '--resume',
    heldFlag: null,
    modelFlag: '--model',
    sessionIdPattern: /^.+$/,
  };
  const adapter = {
    validateModel: (model: string | null | undefined) =>
      new ClaudeAdapter().validateModel(model),
    handoffTarget,
    getConfig: () => ({ handoff: handoffConfig }),
    // Derived from the SAME config, exactly as the base class derives it, so
    // this double cannot answer one thing through `getConfig` and another
    // through the method the service calls.
    handoffUnavailableReason: () =>
      handoffConfig.kind === 'unavailable' ? handoffConfig.reason : null,
  };
  const adapterFor = vi.fn(() => overrides.adapter ?? adapter);
  const service = new HandoffService(
    { fork: () => ({}) } as never,
    { getById: () => Promise.resolve(run) } as never,
    {
      callRecordRows: () => Promise.resolve(overrides.callRows ?? []),
    } as never,
    {
      getByRunNode: () =>
        Promise.resolve(
          overrides.sessionId === null
            ? null
            : {
                agentSessionId: overrides.sessionId ?? 'sess-1',
                agentKind: overrides.nodeAgentKind ?? null,
                model: null,
              },
        ),
    } as never,
    {
      workflowOf: () =>
        Promise.reject(new Error("the run's workflow must not be read")),
    } as never,
    { for: adapterFor } as never,
    {
      peek: (key: string) => (live.has(key) ? {} : null),
      holdsAnyUnder: (prefix: string) =>
        [...live].some((key) => key.startsWith(prefix)),
    } as never,
  );
  return { service, handoffTarget, adapterFor };
}

const WORKFLOW_RUN = {
  id: 'run-1',
  workflowId: 'dev-team',
  agentKind: null,
  model: null,
  cwd: process.cwd(),
};

describe('HandoffService — agent pool', () => {
  it('refuses to hand a terminal session to an Ollama cloud model', async () => {
    const { service } = build({
      adapter: new ClaudeAdapter(),
      run: {
        id: 'run-1',
        workflowId: null,
        agentKind: AgentKind.Claude,
        model: 'ollama/coder:cloud',
        cwd: process.cwd(),
      },
    });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          capabilities: ['completion', 'tools'],
          remote_host: 'https://ollama.com',
        }),
      ),
    );
    try {
      const target = await service.resolve({ runId: 'run-1' });
      expect(target).toEqual({
        kind: 'unavailable',
        command: null,
        args: [],
        cwd: null,
        env: {},
        display: null,
        unavailableReason:
          'Cannot use Ollama model coder:cloud: This Ollama model runs in the cloud, not offline.',
      });
    } finally {
      fetcher.mockRestore();
    }
  });

  it('reopens a pooled call thread under the member that ran it, not the node’s last stamp', async () => {
    const { service, handoffTarget, adapterFor } = build({
      run: {
        ...WORKFLOW_RUN,
        workflowSnapshot: JSON.stringify({
          nodes: [
            {
              id: 'eng',
              kind: 'agent',
              agent: 'claude',
              pool: [
                { agent: 'codex', configDir: '/profiles/b', model: 'gpt' },
              ],
            },
          ],
        }),
      },
      nodeAgentKind: AgentKind.Claude,
      callRows: [
        {
          kind: 'call_result',
          payload: {
            callId: 'call-1',
            callerNodeId: 'orch',
            calleeNodeId: 'eng',
            sessionId: 'thread-codex',
            member: 2,
          },
        },
      ],
    });

    await service.resolve({
      runId: 'run-1',
      nodeId: 'eng',
      sessionId: 'thread-codex',
    });

    expect(adapterFor).toHaveBeenLastCalledWith(AgentKind.Codex);
    expect(handoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'thread-codex',
        configDir: '/profiles/b',
        model: 'gpt',
      }),
    );
  });
});

describe('HandoffService', () => {
  it('answers with the command that reopens THIS run’s own session', async () => {
    const { service, handoffTarget } = build();

    const target = await service.resolve({ runId: 'run-1' });

    // The stored session id is what makes it this conversation and not a fresh
    // one — the adapter must be asked with it, never with nothing.
    expect(handoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
    expect(target).toMatchObject({
      kind: 'command',
      command: 'claude',
      args: ['--resume', 'sess-1'],
      unavailableReason: null,
    });
  });

  it('carries a pasteable line built from the same command it returns', async () => {
    // Two renderings of one invocation that could disagree is how a copied
    // command stops matching the button beside it.
    const { service } = build();

    const target = await service.resolve({ runId: 'run-1' });

    expect(target.display).toBe([target.command, ...target.args].join(' '));
  });

  it('reports the CLI’s OWN reason when it cannot reopen a conversation', async () => {
    // Probe-verified for cursor: `--resume` with an ACP session id silently
    // opens an EMPTY chat. A refusal that reached the user as a generic
    // "unsupported" would leave that indistinguishable from "not yet".
    const { service } = build({
      target: { ok: false, reason: 'unsupported' },
      handoffConfig: {
        kind: 'unavailable',
        reason: 'cursor-agent would open an empty chat',
      },
    });

    const target = await service.resolve({ runId: 'run-1' });

    expect(target.kind).toBe('unavailable');
    expect(target.unavailableReason).toBe(
      'cursor-agent would open an empty chat',
    );
    expect(target.command).toBeNull();
  });

  it('distinguishes "not yet" from "never"', async () => {
    // A chat whose first turn has not run has no session to open, and that is
    // a temporary state — saying the CLI cannot do it at all would be wrong.
    const { service } = build({ target: { ok: false, reason: 'no-session' } });

    const target = await service.resolve({ runId: 'run-1' });

    expect(target.unavailableReason).toMatch(/has not started a session yet/);
  });

  it('refuses rather than answers when the run does not exist', async () => {
    const { service } = build({ run: null });

    await expect(service.resolve({ runId: 'nope' })).rejects.toThrow(
      /RUN_NOT_FOUND|no run/,
    );
  });

  it('rejects a nodeId on a chat run instead of quietly ignoring it', async () => {
    // A chat has one agent and no nodes; accepting a node id would answer for
    // a conversation the caller did not ask about.
    const { service } = build();

    await expect(
      service.resolve({ runId: 'run-1', nodeId: 'worker' }),
    ).rejects.toThrow(/HANDOFF_NODE_UNEXPECTED|does not accept a nodeId/);
  });

  it('tells the adapter the conversation is held while the chat keeps its process', async () => {
    // What a CLI allowing one process per conversation needs: codex refuses a
    // terminal's resume while geniro's kept process has the thread.
    const held = build({ live: ['run-1'] });
    await held.service.resolve({ runId: 'run-1' });
    expect(held.handoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({ held: true }),
    );

    const released = build();
    await released.service.resolve({ runId: 'run-1' });
    expect(released.handoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({ held: false }),
    );
  });

  it('reads a workflow node as held by its own process or any call process of the run', async () => {
    const ask = async (live: string[]): Promise<unknown> => {
      const { service, handoffTarget } = build({
        run: WORKFLOW_RUN,
        nodeAgentKind: AgentKind.Codex,
        live,
      });
      await service.resolve({ runId: 'run-1', nodeId: 'engineer' });
      return (handoffTarget.mock.calls[0] as unknown[])[0];
    };
    expect(await ask(['run-1::node:engineer'])).toMatchObject({ held: true });
    // A call's process is keyed by its conversation, which the request does
    // not name — any live one may hold the thread being handed over.
    expect(await ask(['run-1::call:call-3'])).toMatchObject({ held: true });
    expect(await ask(['run-2::call:call-3'])).toMatchObject({ held: false });
    expect(await ask([])).toMatchObject({ held: false });
  });

  it('prefers an explicitly requested thread over the node’s latest session', async () => {
    // One agent node can hold several threads (a call thread has its own
    // resume id); the caller naming one must not be overridden by the latest.
    const { service, handoffTarget } = build();

    await service.resolve({ runId: 'run-1', sessionId: 'thread-9' });

    expect(handoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'thread-9' }),
    );
  });
});
