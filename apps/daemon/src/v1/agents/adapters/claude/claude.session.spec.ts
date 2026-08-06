import { describe, expect, it } from 'vitest';

import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import type { AgentTurnInput } from '../adapter.types';
import { ClaudeAdapter } from './claude.adapter';

/** A real chat turn: a mode is what keeps stdin — and so the session — open. */
const CHAT: AgentTurnInput = {
  prompt: 'first',
  cwd: '/proj',
  approvalMode: 'ask',
  allowUserQuestions: true,
};

/**
 * The CLI's `result` line — what ends a TURN without ending the CLI. Carries a
 * `stop_reason`: the mapper drops a result describing no work at all, so a
 * barer line would silently never end the turn.
 */
const RESULT_LINE =
  '{"type":"result","is_error":false,"result":"ok","stop_reason":"end_turn"}\n';

function endTurn(child: FakeChild): void {
  child.stdout.emitData(RESULT_LINE);
}

/** Everything written to stdin after the first `n` bytes. */
function after(child: FakeChild, n: number): string {
  return child.stdin.written.slice(n);
}

describe('a run-scoped claude session', () => {
  it('runs a second turn on the same process, writing the next prompt as a user line', async () => {
    // Probe-verified on 2.1.223: two user messages on one still-open stdin
    // produced two `result` lines under ONE session_id, and the process exited
    // only when stdin was closed. That is what keeps the run's MCP servers —
    // and a browser one of them owns — booted once instead of once per message.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    expect(first).not.toBeNull();
    const openingBytes = child.stdin.written.length;
    endTurn(child);
    await first?.done;

    expect(child.stdin.ended).toBe(false);
    expect(session.idle).toBe(true);

    const second = session.startTurn({ ...CHAT, prompt: 'second' }, () => {});
    expect(second).not.toBeNull();
    expect(JSON.parse(after(child, openingBytes))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
    });
    // One spawn, two turns — the whole claim, asserted on the process itself.
    expect(child.kills).toBe(0);
  });

  it('refuses a turn whose argv would differ, so the caller spawns afresh', async () => {
    // A model, folder or plugin directory change is baked into argv at spawn.
    // Serving it on the running process would silently run the turn under the
    // OLD flags while the UI showed the new ones.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(session.startTurn({ ...CHAT, model: 'opus' }, () => {})).toBeNull();
    // …while the same argv still is served.
    expect(session.startTurn(CHAT, () => {})).not.toBeNull();
  });

  it('does not resume mid-session, since the process already holds the session', async () => {
    // `resumeSessionId` is deliberately outside the session key: a continued
    // turn must not re-resume, and keying on it would make every second turn
    // look like a different process and respawn.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(
      session.startTurn({ ...CHAT, resumeSessionId: 'abc' }, () => {}),
    ).not.toBeNull();
  });

  it('serves an approval-mode change on the running process rather than respawning', async () => {
    // `approvalMode` is outside the key too, but for a different reason than
    // resume: a live claude CAN be re-moded (`set_permission_mode`), so a
    // change is applied to the process instead of costing a fresh boot of
    // every MCP server.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(
      session.startTurn({ ...CHAT, approvalMode: 'plan' }, () => {}),
    ).not.toBeNull();
  });

  it('stops a turn in protocol, leaving the process and its MCP servers alive', async () => {
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });
    const handle = session.startTurn(CHAT, () => {});
    const openingBytes = child.stdin.written.length;

    handle?.cancel();

    expect(JSON.parse(after(child, openingBytes))).toEqual({
      type: 'control_request',
      request_id: 'geniro-interrupt',
      request: { subtype: 'interrupt' },
    });
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
  });

  it('kills the process group on close — nothing else ever will', () => {
    // A run-scoped process outlives every turn by design, so the session holder
    // owning `close()` is the ONLY thing standing between a finished run and a
    // CLI that runs until reboot.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });
    session.startTurn(CHAT, () => {});

    session.close();

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });
});

describe('a session the caller did not ask to keep', () => {
  it('closes stdin on the terminal event and serves no second turn', async () => {
    // The one-shot form behind `start()`. `canHostSession` says claude CAN be
    // kept; only a caller with a run to keep it FOR says it should be. A caller
    // with nowhere to store the session would otherwise leak one process per
    // turn, since nothing but `close()` ends a run-scoped one.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT);

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);

    expect(child.stdin.ended).toBe(true);
    expect(session.idle).toBe(false);
    expect(session.startTurn(CHAT, () => {})).toBeNull();

    child.emit('close', 0, null);
    await first?.done;
  });

  it('falls back to killing the group on cancel, having no session to protect', () => {
    // The in-protocol interrupt exists to spare the MCP servers of a process
    // that will serve more turns. A one-shot turn's process dies with it either
    // way, so the kill is both correct and the more certain stop.
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn }).start(CHAT, () => {});
    const openingBytes = child.stdin.written.length;

    handle.cancel();

    expect(after(child, openingBytes)).toBe('');
    expect(child.kills).toBe(1);
  });
});

describe('a CLI that cannot host a session', () => {
  it('serves one turn even when the caller asks for a run-scoped one', async () => {
    // A turn with no permission dialogue has stdin closed after its prompt, so
    // there is no channel for a second one. `canHostSession` reuses exactly
    // that predicate, and the caller's opt-in cannot override a CLI fact.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({ spawn }).startSession(
      { prompt: 'p', cwd: '/proj' },
      { runScoped: true },
    );

    const first = session.startTurn({ prompt: 'p', cwd: '/proj' }, () => {});
    expect(child.stdin.ended).toBe(true);
    expect(
      session.startTurn({ prompt: 'p', cwd: '/proj' }, () => {}),
    ).toBeNull();

    child.emit('close', 0, null);
    await first?.done;
  });
});
