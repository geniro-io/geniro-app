import { describe, expect, it, vi } from 'vitest';

import type {
  AdapterConfig,
  HandoffResult,
} from '../../agents/adapters/adapter.types';
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
    handoffConfig?: AdapterConfig['handoff'];
    sessionId?: string | null;
  } = {},
) {
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
      },
  );
  const adapter = {
    handoffTarget,
    getConfig: () => ({
      handoff: overrides.handoffConfig ?? {
        kind: 'resume-command' as const,
        resumeFlag: '--resume',
        modelFlag: '--model',
        sessionIdPattern: /^.+$/,
      },
    }),
  };
  const service = new HandoffService(
    { fork: () => ({}) } as never,
    { getById: () => Promise.resolve(run) } as never,
    {
      getByRunNode: () =>
        Promise.resolve(
          overrides.sessionId === null
            ? null
            : { agentSessionId: overrides.sessionId ?? 'sess-1' },
        ),
    } as never,
    {
      get: () => Promise.reject(new Error('workflow store must not be read')),
    } as never,
    { for: () => adapter } as never,
  );
  return { service, handoffTarget };
}

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
