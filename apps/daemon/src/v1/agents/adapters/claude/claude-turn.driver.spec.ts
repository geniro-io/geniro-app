import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TurnIo } from '../adapter.types';
import {
  CLAUDE_MCP_READY_MAX_WAIT_MS,
  CLAUDE_MCP_READY_POLL_MS,
  CLAUDE_MCP_READY_STALL_MS,
} from './claude.const';
import { ClaudeTurnDriver } from './claude-turn.driver';

/** One `mcp_status` reading, as the CLI would answer poll `id`. */
const reply = (
  id: string,
  servers: readonly { name: string; status: string }[],
): unknown => ({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: id,
    response: { mcpServers: servers },
  },
});

const refusal = (id: string): unknown => ({
  type: 'control_response',
  response: { subtype: 'error', request_id: id, error: 'unknown subtype' },
});

/**
 * Drive the gate on a fake clock, answering each poll from a scripted list of
 * readings — the CLI's own `mcp_status` conversation with no process in it.
 *
 * `answer` is called with the poll's request id and returns the line to feed
 * back, or null to leave that poll unanswered. Answering INSIDE `write` is what
 * a real CLI does relative to the driver's own timers, so the gate's ordering
 * is exercised rather than simulated.
 */
function gate(answer: (id: string, poll: number) => unknown | null) {
  const events: AgentEvent[] = [];
  const mapMessage = vi.fn((): AgentEvent[] => []);
  let clock = 0;
  let polls = 0;
  const writes: string[] = [];
  // A holder rather than a `let`: `io.write` answers the poll by calling back
  // into the driver, so the two are mutually referential and one has to be
  // reachable through a box.
  const box: { driver?: ClaudeTurnDriver } = {};
  const io: TurnIo = {
    write: (payload) => {
      writes.push(payload);
      const line = JSON.parse(payload) as { request_id: string };
      const answered = answer(line.request_id, ++polls);
      if (answered !== null) {
        box.driver?.onMessage(answered);
      }
      return true;
    },
    emit: (event) => events.push(event),
  };
  const driver = new ClaudeTurnDriver({
    mapMessage,
    buildApprovalResponse: () => undefined,
    now: () => clock,
    // Only the POLL gap moves the clock. The reply-timeout timer is armed on
    // every poll and never fires when the CLI answers, so counting it would
    // make this clock run several times faster than real time and reach the
    // deadline after a handful of healthy polls.
    delay: (ms) => {
      if (ms === CLAUDE_MCP_READY_POLL_MS) {
        clock += ms;
      }
      return Promise.resolve();
    },
  });
  box.driver = driver;
  return {
    driver,
    io,
    events,
    mapMessage,
    writes,
    get polls() {
      return polls;
    },
    get clock() {
      return clock;
    },
  };
}

describe('holding the first prompt until the MCP servers are up', () => {
  it('waits while a server is still dialling, then releases', async () => {
    // The reported defect, as a test. Measured on 2.1.232: claude dials its MCP
    // servers at PROCESS start and runs a turn without waiting, so a prompt
    // sent three seconds in got 148 tools with none of playwright's, while the
    // same prompt held to eight seconds got 466 tools and all 24 of them.
    const readings = [
      [{ name: 'playwright', status: 'pending' }],
      [{ name: 'playwright', status: 'pending' }],
      [{ name: 'playwright', status: 'connected' }],
      [{ name: 'playwright', status: 'connected' }],
    ];
    const g = gate((id, poll) => reply(id, readings[poll - 1] ?? []));

    await g.driver.awaitPromptReady(g.io);

    // Released only once a settled reading REPEATED — four polls, not three.
    expect(g.polls).toBe(4);
    expect(g.events).toEqual([]);
  });

  it('does NOT release on the first reading that happens to show nothing pending', async () => {
    // This is the whole reason the gate needs two readings. Discovery is
    // gradual — measured, the list went from 6 servers to 45 between 0.8s and
    // 1.2s — so a moment when nothing is pending is also what a half-discovered
    // list looks like, and releasing on it puts the prompt out mid-discovery.
    const g = gate((id, poll) =>
      reply(
        id,
        poll === 1
          ? [{ name: 'github', status: 'connected' }]
          : [
              { name: 'github', status: 'connected' },
              { name: 'playwright', status: 'pending' },
            ],
      ),
    );

    const settled = vi.fn();
    const held = g.driver.awaitPromptReady(g.io).then(settled);
    // One microtask turn is plenty for a gate that released on poll 1.
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await held;
    expect(g.polls).toBeGreaterThan(2);
  });

  it('gives up at once on a CLI that will not answer the question', async () => {
    // A renamed subtype in a later release must cost the FIX, never the turn —
    // releasing immediately is exactly the behaviour that shipped before the
    // gate existed.
    const g = gate((id) => refusal(id));

    await g.driver.awaitPromptReady(g.io);

    expect(g.polls).toBe(1);
    expect(g.clock).toBe(0);
    expect(g.events).toEqual([]);
  });

  it('gives up when the transport refuses the write', async () => {
    const events: AgentEvent[] = [];
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [],
      buildApprovalResponse: () => undefined,
      delay: () => Promise.resolve(),
    });

    await driver.awaitPromptReady({
      write: () => false,
      emit: (event) => events.push(event),
    });

    expect(events).toEqual([]);
  });

  it('asks again after a poll that goes unanswered, rather than giving up', async () => {
    // Measured on the real daemon: the opening poll of a cold CLI went
    // unanswered, and a gate that read silence as "this build has no such
    // subtype" abandoned the wait for the whole session — on a CLI that
    // answered every later poll in well under a second. Silence is "not yet".
    const g = gate((id, poll) =>
      poll === 1
        ? null
        : reply(id, [{ name: 'playwright', status: 'connected' }]),
    );

    await g.driver.awaitPromptReady(g.io);

    // Poll 1 silent, then two agreeing readings.
    expect(g.polls).toBe(3);
    expect(g.events).toEqual([]);
  });

  it('keeps waiting for a slow folder while discovery is still MOVING', async () => {
    // The reported case: remote servers (claude.ai, Amplitude) had not finished
    // dialling when the flat 15s ceiling expired, so their tools were missing
    // from the first message even though the reading was visibly still
    // changing. The gate now times a STALL, so progress renews the wait.
    let poll = 0;
    const g = gate((id) => {
      poll += 1;
      // Discovery keeps MOVING: a further server is found on each of the first
      // 40 polls, and the two remote ones stay pending well past the stall
      // window before connecting. Slow, but never stuck — exactly the folder
      // the flat ceiling used to cut off.
      const discovered = Array.from({ length: Math.min(poll, 40) }, (_, i) => ({
        name: `local-${i}`,
        status: 'connected' as const,
      }));
      return reply(id, [
        ...discovered,
        { name: 'claude.ai', status: poll < 45 ? 'pending' : 'connected' },
        { name: 'Amplitude', status: poll < 45 ? 'pending' : 'connected' },
      ]);
    });

    await g.driver.awaitPromptReady(g.io);

    // Released because everything came up — NOT because a ceiling expired, so
    // the turn keeps the tools and the user is told nothing.
    expect(g.events).toEqual([]);
    expect(g.clock).toBeGreaterThan(CLAUDE_MCP_READY_STALL_MS);
    expect(g.clock).toBeLessThan(CLAUDE_MCP_READY_MAX_WAIT_MS);
  });

  it('gives up on a server that is STUCK, without waiting out the ceiling', async () => {
    // The stall window is what keeps the patience above from becoming a hang:
    // an unreachable host reports the same reading forever, so nothing changes
    // and the prompt goes out well inside the hard ceiling.
    const g = gate((id) =>
      reply(id, [
        { name: 'reachable', status: 'connected' },
        { name: 'broken', status: 'pending' },
      ]),
    );

    await g.driver.awaitPromptReady(g.io);

    expect(g.clock).toBeLessThan(CLAUDE_MCP_READY_MAX_WAIT_MS);
    const notice = g.events[0];
    if (notice?.type !== 'notice') {
      throw new Error(`expected a notice, got ${String(notice?.type)}`);
    }
    expect(notice.message).toContain('broken');
    expect(notice.message).not.toContain('reachable');
  });

  it('still stops for a CLI that never answers at all', async () => {
    // The other half of the same decision: retrying forever would hold the
    // user's message until the turn's 30-minute silence deadline settled it,
    // which is worse than the defect. The empty grace is what bounds it.
    const g = gate(() => null);

    await g.driver.awaitPromptReady(g.io);

    expect(g.polls).toBeGreaterThan(1);
    expect(g.clock).toBeLessThan(CLAUDE_MCP_READY_STALL_MS);
    expect(g.events).toEqual([]);
  });

  it('stops waiting on a machine that reports no servers at all', async () => {
    // An empty reading is "discovery has not finished", so it is believed for a
    // grace and no longer — otherwise a user with no MCP servers would pay the
    // full deadline on the first message of every chat.
    const g = gate((id) => reply(id, []));

    await g.driver.awaitPromptReady(g.io);

    expect(g.clock).toBeLessThan(CLAUDE_MCP_READY_STALL_MS);
    expect(g.events).toEqual([]);
  });

  it('says out loud which servers it gave up waiting for', async () => {
    // Past the deadline the turn runs with the old, broken surface. Silence
    // there is the original bug report — "playwright is in the list but the
    // agent can't use it" — so the turn carries the reason instead.
    const g = gate((id) =>
      reply(id, [
        { name: 'playwright', status: 'pending' },
        { name: 'github', status: 'connected' },
      ]),
    );

    await g.driver.awaitPromptReady(g.io);

    expect(g.clock).toBeGreaterThanOrEqual(CLAUDE_MCP_READY_STALL_MS);
    expect(g.events).toHaveLength(1);
    const notice = g.events[0];
    if (notice?.type !== 'notice') {
      throw new Error(`expected a notice, got ${String(notice?.type)}`);
    }
    expect(notice.message).toContain('playwright');
    // Only what was actually still starting.
    expect(notice.message).not.toContain('github');
    // INFO rather than the advisory chrome this once asserted. The degrade is
    // real, but nothing FAILED — the turn ran, the servers finish behind it and
    // the next message has them. A red banner here was read as a fault to
    // report ("i see this error") on a turn that had worked.
    expect(notice.severity).toBe('info');
  });
});

describe('the driver’s other half is the stateless default', () => {
  it('consumes its OWN poll replies and maps everything else', () => {
    const g = gate((id) => reply(id, [{ name: 'a', status: 'connected' }]));
    // Open a poll so the driver has one in flight to match against.
    void g.driver.awaitPromptReady(g.io);

    const assistant = { type: 'assistant', message: { content: [] } };
    expect(g.driver.onMessage(assistant)).toEqual([]);
    expect(g.mapMessage).toHaveBeenCalledWith(assistant);
  });

  it('maps an mcp_status reply nobody asked for', () => {
    // Consuming a stray control response would silently swallow a line the
    // adapter's own mapper is responsible for.
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [{ type: 'turn_cancelled' }],
      buildApprovalResponse: () => undefined,
    });

    expect(driver.onMessage(reply('geniro-mcp-1', []))).toEqual([
      { type: 'turn_cancelled' },
    ]);
  });

  it('delegates verdict encoding to the adapter', () => {
    const buildApprovalResponse = vi.fn(() => 'LINE\n');
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [],
      buildApprovalResponse,
    });

    expect(driver.buildApprovalResponse('id-1', true, { a: 1 })).toBe('LINE\n');
    expect(buildApprovalResponse).toHaveBeenCalledWith('id-1', true, { a: 1 });
  });
});

describe('the window a compaction left behind', () => {
  /** A driver whose mapper replays one scripted line's events at a time. */
  const driverOver = (script: AgentEvent[][]) => {
    let line = 0;
    return new ClaudeTurnDriver({
      mapMessage: () => script[line++] ?? [],
      buildApprovalResponse: () => undefined,
    });
  };

  const compacted = (postTokens: number | null): AgentEvent => ({
    type: 'context_compacted',
    phase: 'finished',
    trigger: 'manual',
    preTokens: 515_000,
    postTokens,
  });

  const completed = (contextTokens: number): AgentEvent => ({
    type: 'turn_complete',
    stopReason: 'end_turn',
    finalText: null,
    usage: {
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      contextTokens,
      contextWindowTokens: 200_000,
      contextModel: null,
      durationMs: null,
      apiMs: null,
      costUsd: 1,
    },
  });

  it('announces the new reading at once, so the meter drops with the compaction', () => {
    const driver = driverOver([[compacted(12_600)]]);

    // The live plane's own event, beside the boundary rather than instead of
    // it: the boundary is what names the pause, this is what moves the ring.
    expect(driver.onMessage({})).toEqual([
      compacted(12_600),
      { type: 'context_progress', contextTokens: 12_600 },
    ]);
  });

  it('stamps it onto the turn’s result, which still carries the pre-compaction prompt', () => {
    const driver = driverOver([[compacted(12_600)], [completed(515_000)]]);
    driver.onMessage({});

    // Without this the reopened chat reads 515k — the prompt of the request the
    // compaction has just replaced — for the rest of the conversation.
    expect(driver.onMessage({})).toEqual([completed(12_600)]);
  });

  it('yields to a request that measured the window ITSELF after the compaction', () => {
    const driver = driverOver([
      [compacted(12_600)],
      [{ type: 'context_progress', contextTokens: 30_000 }],
      [completed(31_500)],
    ]);
    driver.onMessage({});
    driver.onMessage({});

    // An AUTO compaction happens mid-turn and the turn carries on: every
    // request after it reports the real figure, and the result's is the latest
    // of them. Only a turn that ENDED on its compaction needs the stamp.
    expect(driver.onMessage({})).toEqual([completed(31_500)]);
  });

  it('invents nothing for a compaction that reported no post_tokens', () => {
    const driver = driverOver([[compacted(null)], [completed(515_000)]]);

    expect(driver.onMessage({})).toEqual([compacted(null)]);
    expect(driver.onMessage({})).toEqual([completed(515_000)]);
  });

  it('ignores a DELEGATE’s compaction — the meter reports the conversation', () => {
    const delegate: AgentEvent = {
      ...compacted(900),
      parentToolUseId: 'toolu_1',
    };
    const driver = driverOver([[delegate], [completed(515_000)]]);

    expect(driver.onMessage({})).toEqual([delegate]);
    expect(driver.onMessage({})).toEqual([completed(515_000)]);
  });
});

describe('the request the provider failed', () => {
  /** A driver whose mapper replays one scripted line's events at a time. */
  const driverOver = (script: AgentEvent[][]): ClaudeTurnDriver => {
    let line = 0;
    return new ClaudeTurnDriver({
      mapMessage: () => script[line++] ?? [],
      buildApprovalResponse: () => undefined,
    });
  };

  /** The synthetic line claude writes when the API refuses a request. */
  const apiErrorLine = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'API error' }],
    },
    error: 'model_not_found',
    request_id: 'req_011CeAL4KP2RkG9YEPGrdi2n',
    is_api_error_message: true,
  };

  it('carries the request id from the line that reported it to the error', () => {
    // The two halves arrive on DIFFERENT lines — the id on the synthetic
    // assistant line, the failure one line later — so a per-line mapper cannot
    // join them and this is the only place that can. The id is also the one
    // field nothing else in the app can reconstruct, and the whole point of
    // showing detail is being able to hand it over.
    const driver = driverOver([
      [{ type: 'text', text: 'API error' }],
      [{ type: 'error', message: 'API error', detail: { httpStatus: 404 } }],
    ]);

    driver.onMessage(apiErrorLine);

    expect(driver.onMessage({ type: 'result', is_error: true })).toEqual([
      {
        type: 'error',
        message: 'API error',
        detail: {
          code: 'model_not_found',
          requestId: 'req_011CeAL4KP2RkG9YEPGrdi2n',
          // The result line's own reading survives: it describes the turn's
          // ending, while the remembered pair describes one request.
          httpStatus: 404,
        },
      },
    ]);
  });

  it('lets the failing line’s OWN code win over the remembered one', () => {
    const driver = driverOver([
      [],
      [{ type: 'error', message: 'API error', detail: { code: 'api_error' } }],
    ]);

    driver.onMessage(apiErrorLine);

    expect(driver.onMessage({})).toEqual([
      {
        type: 'error',
        message: 'API error',
        detail: {
          code: 'api_error',
          requestId: 'req_011CeAL4KP2RkG9YEPGrdi2n',
        },
      },
    ]);
  });

  it('reads nothing off an ordinary line, and spends what it read once', () => {
    // `request_id` rides ordinary lines too — `is_api_error_message` is the
    // only thing that says this one is a failure — and a second failure in the
    // same turn must report its own facts or none, never the previous one's.
    // One entry per onMessage call, including the two raw lines below, which
    // the mapper sees like any other.
    const driver = driverOver([
      [],
      [{ type: 'error', message: 'first' }],
      [],
      [{ type: 'error', message: 'second' }],
    ]);

    driver.onMessage({ type: 'assistant', request_id: 'req_ordinary' });
    expect(driver.onMessage({})).toEqual([{ type: 'error', message: 'first' }]);

    driver.onMessage(apiErrorLine);
    expect(driver.onMessage({})).toEqual([
      {
        type: 'error',
        message: 'second',
        detail: {
          code: 'model_not_found',
          requestId: 'req_011CeAL4KP2RkG9YEPGrdi2n',
        },
      },
    ]);
    expect(driver.onMessage({})).toEqual([]);
  });
});
