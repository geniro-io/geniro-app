import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TurnIo } from '../adapter.types';
import {
  CLAUDE_MCP_READY_MAX_WAIT_MS,
  CLAUDE_MCP_READY_POLL_MS,
  CLAUDE_MCP_READY_STALL_MS,
  CLAUDE_MCP_RECONNECT_FAILED_MESSAGE,
  CLAUDE_MCP_RECONNECTED_MESSAGE,
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

  /** The notice the mapper now makes of that line. */
  const API_NOTICE = {
    type: 'notice' as const,
    message: 'API Error: Connection lost mid-response.',
    severity: 'warning' as const,
    caption: 'api error',
  };

  it('withholds the advisory when the turn ENDS on the very same sentence', () => {
    // MEASURED over every api-error row a real claude run has produced: the
    // four FATAL ones are followed by the turn's own `error` at the next seq,
    // 2–4ms later, carrying a byte-identical message. Publishing both stacks an
    // amber row directly on a red one saying the same words.
    const driver = driverOver([
      [API_NOTICE],
      [{ type: 'error', message: 'API Error: Connection lost mid-response.' }],
    ]);

    expect(driver.onMessage(apiErrorLine)).toEqual([]);
    expect(driver.onMessage({ type: 'result', is_error: true })).toEqual([
      {
        type: 'error',
        message: 'API Error: Connection lost mid-response.',
        detail: {
          code: 'model_not_found',
          requestId: 'req_011CeAL4KP2RkG9YEPGrdi2n',
        },
      },
    ]);
  });

  it('publishes it AHEAD of the work that proved the turn carried on', () => {
    // The other eight measured rows: the turn recovered and ran for 15 to 211
    // more items. Here the advisory is the only record that anything went
    // wrong, and it belongs where it happened — not at the terminal, which on
    // that data was up to 211 rows later.
    const driver = driverOver([
      [API_NOTICE],
      [{ type: 'tool_call', id: 't1', name: 'Read', input: null }],
    ]);

    expect(driver.onMessage(apiErrorLine)).toEqual([]);
    expect(driver.onMessage({ type: 'assistant' })).toEqual([
      API_NOTICE,
      { type: 'tool_call', id: 't1', name: 'Read', input: null },
    ]);
  });

  it('still shows both when the turn fails for an UNRELATED reason', () => {
    // Adjacency is not the discriminator — the messages are. A turn that
    // recovered from an api error and then died of something else has two
    // things to report, and reporting one would hide the other.
    const driver = driverOver([
      [API_NOTICE],
      [{ type: 'error', message: 'claude run failed (aborted_tools)' }],
    ]);

    driver.onMessage(apiErrorLine);
    expect(driver.onMessage({ type: 'result', is_error: true })).toEqual([
      API_NOTICE,
      expect.objectContaining({ message: 'claude run failed (aborted_tools)' }),
    ]);
  });

  it('never takes charge of a lone notice some OTHER producer wrote', () => {
    // The MCP-readiness advisory and a relayed compaction summary are both lone
    // notices. Gating on the event shape would have this method silently
    // holding back rows it knows nothing about.
    const driver = driverOver([
      [
        {
          type: 'notice',
          message: 'still starting: ticktick',
          severity: 'info',
        },
      ],
    ]);

    expect(driver.onMessage({ type: 'system', subtype: 'whatever' })).toEqual([
      { type: 'notice', message: 'still starting: ticktick', severity: 'info' },
    ]);
  });

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

describe('repairing an MCP server that dropped out of the session', () => {
  const notConnected = (server: string): unknown => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          content: `MCP server "${server}" is not connected`,
        },
      ],
    },
  });

  const reconnectReply = (id: string, error?: string): unknown => ({
    type: 'control_response',
    response:
      error === undefined
        ? { subtype: 'success', request_id: id }
        : { subtype: 'error', request_id: id, error },
  });

  /** A driver holding a live stdin, with every write captured. */
  function repairing(writeOk = true) {
    const writes: string[] = [];
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [],
      buildApprovalResponse: () => undefined,
    });
    driver.onStdinReady({
      write: (payload) => {
        writes.push(payload);
        return writeOk;
      },
      emit: () => undefined,
    });
    const sent = () =>
      writes.map(
        (payload) =>
          JSON.parse(payload) as {
            request_id: string;
            request: { subtype: string; serverName?: string };
          },
      );
    return { driver, sent };
  }

  it('re-dials the named server when a tool call says it is not connected', () => {
    // The reported failure: four calls on one claude.ai connector over 23
    // seconds, every one of them "is not connected", with nothing in geniro
    // able to repair or explain it.
    const { driver, sent } = repairing();

    driver.onMessage(notConnected('claude.ai Manifest OS Google Workspace'));

    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.request).toEqual({
      subtype: 'mcp_reconnect',
      serverName: 'claude.ai Manifest OS Google Workspace',
    });
  });

  it('says nothing until the reply, then reports the server is back', () => {
    const { driver, sent } = repairing();

    // The attempt itself is silent — only the reply knows the outcome.
    expect(driver.onMessage(notConnected('linear'))).toEqual([]);

    const id = sent()[0]?.request_id ?? '';
    expect(driver.onMessage(reconnectReply(id))).toEqual([
      {
        type: 'notice',
        severity: 'info',
        message: CLAUDE_MCP_RECONNECTED_MESSAGE.replace('%s', 'linear'),
      },
    ]);
  });

  it("quotes the CLI's own reason when the re-dial failed", () => {
    // Measured against the broken profile on 2.1.247. This sentence is the
    // whole point of asking: "not connected" says a tool is missing, this says
    // the account's connector record points at a server that no longer exists.
    const error =
      'Error POSTing to endpoint: {"error":{"type":"not_found_error","message":"Server not found"}}';
    const { driver, sent } = repairing();

    driver.onMessage(notConnected('claude.ai Manifest OS Google Workspace'));
    const events = driver.onMessage(
      reconnectReply(sent()[0]?.request_id ?? '', error),
    );

    expect(events).toEqual([
      {
        type: 'notice',
        severity: 'warning',
        message: CLAUDE_MCP_RECONNECT_FAILED_MESSAGE.replace(
          '%s',
          'claude.ai Manifest OS Google Workspace',
        ).replace('%r', error),
      },
    ]);
  });

  it('sends ONE request while the model retries the same dead tool', () => {
    const { driver, sent } = repairing();

    driver.onMessage(notConnected('linear'));
    driver.onMessage(notConnected('linear'));
    driver.onMessage(notConnected('linear'));

    expect(sent()).toHaveLength(1);
  });

  it('never asks again about a server the CLI said it could not reconnect', () => {
    const { driver, sent } = repairing();

    driver.onMessage(notConnected('linear'));
    driver.onMessage(
      reconnectReply(sent()[0]?.request_id ?? '', 'Server not found'),
    );
    driver.onMessage(notConnected('linear'));

    expect(sent()).toHaveLength(1);
  });

  it('repairs a server that drops AGAIN after a successful repair', () => {
    // A new incident, not a retry of the old one — and the driver outlives the
    // turn (one per session), so without this a chat gets one repair per server
    // for its whole life.
    const { driver, sent } = repairing();

    driver.onMessage(notConnected('linear'));
    driver.onMessage(reconnectReply(sent()[0]?.request_id ?? ''));
    driver.onMessage(notConnected('linear'));

    expect(sent()).toHaveLength(2);
    expect(sent()[1]?.request.serverName).toBe('linear');
  });

  it('does not record an attempt whose write never landed', () => {
    // A refused write reached the CLI with nothing, so the next failure must
    // still be able to ask; and no reply can ever arrive for it, so recording
    // one would leave a phantom attempt in flight.
    const { driver, sent } = repairing(false);

    driver.onMessage(notConnected('linear'));
    driver.onMessage(notConnected('linear'));

    expect(sent()).toHaveLength(2);
  });

  it('stays silent when the session has no stdin channel', () => {
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [],
      buildApprovalResponse: () => undefined,
    });

    expect(driver.onMessage(notConnected('linear'))).toEqual([]);
  });

  it('leaves the failed tool row above the notice it earned', () => {
    // Order is the claim: the transcript reads "this call failed" and then
    // "here is why", never the other way round.
    const toolRow: AgentEvent = {
      type: 'tool_result',
      id: 't1',
      name: null,
      result: 'MCP server "linear" is not connected',
      isError: true,
    };
    const writes: string[] = [];
    const driver = new ClaudeTurnDriver({
      mapMessage: () => [toolRow],
      buildApprovalResponse: () => undefined,
    });
    driver.onStdinReady({
      write: (payload) => {
        writes.push(payload);
        return true;
      },
      emit: () => undefined,
    });

    expect(driver.onMessage(notConnected('linear'))).toEqual([toolRow]);
    expect(writes).toHaveLength(1);
  });
});
