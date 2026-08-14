import { describe, expect, it, vi } from 'vitest';

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
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
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
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(session.startTurn({ ...CHAT, model: 'opus' }, () => {})).toBeNull();
    // …while the same argv still is served.
    expect(session.startTurn(CHAT, () => {})).not.toBeNull();
  });

  it('refuses a turn that must load no MCP servers on a process that loaded them', async () => {
    // `isolateMcpServers` is argv — `--mcp-config {} --strict-mcp-config`, and
    // `buildArgs` returns early on it. Serving such a turn on a process spawned
    // without those flags runs it against every server the folder defines,
    // which is the whole cost the field exists to avoid; the reverse is worse
    // still, an ordinary turn silently running with NO MCP servers while the
    // panel lists them. Either way the process cannot serve both.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(
      session.startTurn({ ...CHAT, isolateMcpServers: true }, () => {}),
    ).toBeNull();
    // …while the argv it WAS spawned with is still served, so the refusal is
    // about the flag and not about the session being spent.
    expect(session.startTurn(CHAT, () => {})).not.toBeNull();
  });

  it('does not resume mid-session, since the process already holds the session', async () => {
    // `resumeSessionId` is deliberately outside the session key: a continued
    // turn must not re-resume, and keying on it would make every second turn
    // look like a different process and respawn.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(
      session.startTurn({ ...CHAT, resumeSessionId: 'abc' }, () => {}),
    ).not.toBeNull();
  });

  it('DELIVERS an approval-mode change to the running process, ahead of the prompt', async () => {
    // `approvalMode` is outside the key too, but for a different reason than
    // resume: a live claude CAN be re-moded (`set_permission_mode`), so a
    // change is applied to the process instead of costing a fresh boot of
    // every MCP server.
    //
    // Accepting the turn is NOT the claim — the mode is baked into argv at
    // spawn, so a turn that is merely accepted runs under the PREVIOUS mode.
    // The bytes are the claim: without them a chat switched back to `ask`
    // between turns goes on editing files with no permission request, while
    // the chip and the persisted run row both read `ask`.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;
    const openingBytes = child.stdin.written.length;

    expect(
      session.startTurn({ ...CHAT, approvalMode: 'plan' }, () => {}),
    ).not.toBeNull();

    const [modeLine, promptLine] = after(child, openingBytes)
      .trim()
      .split('\n');
    expect(JSON.parse(modeLine!)).toEqual({
      type: 'control_request',
      request_id: 'geniro-set_permission_mode',
      request: { subtype: 'set_permission_mode', mode: 'plan' },
    });
    // Strictly BEFORE the prompt it has to govern — a mode arriving after the
    // user line would leave that turn running under the old posture.
    expect(JSON.parse(promptLine!).type).toBe('user');
  });

  it('re-sends a mode only when it actually changed', async () => {
    // The delivered mode becomes the new baseline. Without that, every later
    // turn would re-send a `set_permission_mode` the process is already in.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    const second = session.startTurn(
      { ...CHAT, approvalMode: 'plan' },
      () => {},
    );
    endTurn(child);
    await second?.done;
    const afterSecond = child.stdin.written.length;

    session.startTurn(
      { ...CHAT, approvalMode: 'plan', prompt: 'third' },
      () => {},
    );

    expect(after(child, afterSecond)).not.toContain('set_permission_mode');
  });

  it('refuses a turn that drops the mode entirely, rather than keeping the old one', async () => {
    // "No mode at all" is the CLI's own default, and no message asks a running
    // process to go back to it. Replacing the refusal with an empty mode line
    // compiles and keeps the rest of the suite green — while silently running
    // the turn under the PREVIOUS posture, which is the whole failure this
    // machinery exists to prevent.
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    endTurn(child);
    await first?.done;

    expect(
      session.startTurn({ ...CHAT, approvalMode: undefined }, () => {}),
    ).toBeNull();
  });

  it('never hosts a session it could not re-mode, so the refusal cannot arise here', () => {
    // Both answers come from `keepStdinOpen`, deliberately: an `auto` turn
    // spawns under --dangerously-skip-permissions with no prompt tool, and it
    // is the same missing dialogue that makes the process unable to take a
    // second prompt at all. So claude never reaches the base's
    // cannot-be-re-moded refusal — that branch is pinned at the base instead
    // (`agent-adapter.spec.ts`), on an adapter that CAN host a session and has
    // no mode message.
    const AUTO: AgentTurnInput = {
      prompt: 'first',
      cwd: '/proj',
      approvalMode: 'auto',
    };
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(AUTO, {
      runScoped: true,
    });

    session.startTurn(AUTO, () => {});

    // stdin closed with the payload — a one-turn process, not a session.
    expect(child.stdin.ended).toBe(true);
    expect(
      session.startTurn({ ...AUTO, prompt: 'second' }, () => {}),
    ).toBeNull();
  });

  it('stops a turn in protocol, leaving the process and its MCP servers alive', async () => {
    const { spawn, child } = fakeSpawn();
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
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
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT, {
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
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession(CHAT);

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
    const handle = new ClaudeAdapter({ spawn, waitForMcpServers: false }).start(
      CHAT,
      () => {},
    );
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
    const session = new ClaudeAdapter({
      spawn,
      waitForMcpServers: false,
    }).startSession({ prompt: 'p', cwd: '/proj' }, { runScoped: true });

    const first = session.startTurn({ prompt: 'p', cwd: '/proj' }, () => {});
    expect(child.stdin.ended).toBe(true);
    expect(
      session.startTurn({ prompt: 'p', cwd: '/proj' }, () => {}),
    ).toBeNull();

    child.emit('close', 0, null);
    await first?.done;
  });
});

/**
 * A child that answers `mcp_status` the way claude 2.1.232 does — the one
 * behavioural variant this spec needs, kept a subclass here rather than added
 * to the shared double (which must decide nothing).
 *
 * `servers` is what each successive poll is told; the last entry repeats, since
 * the gate keeps asking until two readings agree.
 */
class McpStatusChild extends FakeChild {
  polls = 0;

  constructor(
    private readonly readings: readonly (readonly {
      name: string;
      status: string;
    }[])[],
  ) {
    super();
    const stdin = this.stdin;
    const write = stdin.write.bind(stdin);
    stdin.write = (chunk: string): boolean => {
      const accepted = write(chunk);
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (!line.includes('"mcp_status"')) {
          continue;
        }
        const { request_id: id } = JSON.parse(line) as { request_id: string };
        const rows = this.readings[this.polls] ?? this.readings.at(-1) ?? [];
        this.polls += 1;
        // On the next tick, like a real reply — a synchronous one would arrive
        // inside the driver's own `write` call.
        setImmediate(() =>
          this.stdout.emitData(
            `${JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: id,
                response: { mcpServers: rows },
              },
            })}\n`,
          ),
        );
      }
      return accepted;
    };
  }
}

describe('a claude session holds its first prompt for the MCP servers', () => {
  it('sends nothing until the CLI reports every server settled', async () => {
    // The wiring, pinned end to end: the gate lives on the driver and the hold
    // lives in the transport, but neither does anything unless the session
    // actually hands one to the other. Without that one line the fix is inert
    // and every other spec here still passes.
    const child = new McpStatusChild([
      [{ name: 'playwright', status: 'pending' }],
      [{ name: 'playwright', status: 'connected' }],
      [{ name: 'playwright', status: 'connected' }],
    ]);
    const { spawn } = fakeSpawn(child);
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    expect(first).not.toBeNull();
    // Polling has begun and the user's message has NOT gone out with it.
    expect(child.stdin.written).not.toContain('first');

    await vi.waitFor(() => expect(child.stdin.written).toContain('first'));
    // Three readings: pending, settled, and the repeat that confirms it.
    expect(child.polls).toBe(3);
    endTurn(child);
    await first?.done;
  }, 10_000);

  it('does not hold the SECOND turn — the wait belongs to the process', async () => {
    // Re-asking would add the poll gap to every message of the chat, and could
    // never find anything: the servers have been up since the first turn.
    const child = new McpStatusChild([[{ name: 'a', status: 'connected' }]]);
    const { spawn } = fakeSpawn(child);
    const session = new ClaudeAdapter({ spawn }).startSession(CHAT, {
      runScoped: true,
    });

    const first = session.startTurn(CHAT, () => {});
    await vi.waitFor(() => expect(child.stdin.written).toContain('first'));
    endTurn(child);
    await first?.done;
    const pollsAfterFirst = child.polls;
    const bytes = child.stdin.written.length;

    const second = session.startTurn({ ...CHAT, prompt: 'second' }, () => {});
    expect(second).not.toBeNull();
    // Synchronously on stdin, with no poll in front of it.
    expect(after(child, bytes)).toContain('second');
    expect(child.polls).toBe(pollsAfterFirst);
    endTurn(child);
    await second?.done;
  }, 10_000);

  it('does not hold a turn that loads no servers by construction', async () => {
    // `isolateMcpServers` runs under `--strict-mcp-config` with an empty
    // config, so there is nothing to dial and every poll would return the same
    // empty list until the grace ran out — on a turn geniro cancels after one
    // line anyway.
    const child = new McpStatusChild([[]]);
    const { spawn } = fakeSpawn(child);
    const session = new ClaudeAdapter({ spawn }).startSession(
      { ...CHAT, isolateMcpServers: true },
      { runScoped: true },
    );

    session.startTurn({ ...CHAT, isolateMcpServers: true }, () => {});

    expect(child.stdin.written).toContain('first');
    expect(child.polls).toBe(0);
  });
});
