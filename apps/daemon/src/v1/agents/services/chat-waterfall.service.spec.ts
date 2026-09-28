import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { RunWaterfallWireSchema } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { ToolUsageGroup } from '../utils/tool-usage';
import { ChatWaterfallService } from './chat-waterfall.service';
import type { PolledSpendService } from './polled-spend.service';

interface StoredRow {
  seq: number;
  kind: string;
  nodeId: string | null;
  payload: unknown;
  secondsIn: number;
}

const T0 = Date.parse('2026-09-07T12:00:00.000Z');
const at = (secondsIn: number): Date => new Date(T0 + secondsIn * 1000);
const iso = (secondsIn: number): string => at(secondsIn).toISOString();

function row(
  seq: number,
  kind: string,
  payload: unknown,
  secondsIn: number,
  nodeId: string | null = null,
): StoredRow {
  return { seq, kind, nodeId, payload, secondsIn };
}

const PAYLOAD_KINDS = new Set([
  'turn_complete',
  'subagent_info',
  'call_started',
  'call_result',
  'approval_request',
  'approval_verdict',
  'status',
]);

interface NodeStateStub {
  nodeId: string;
  agentKind: string | null;
  polledCostCents?: number | null;
  polledCostEvents?: number | null;
}

function build(
  rows: StoredRow[],
  options: {
    runExists?: boolean;
    status?: string;
    agentKind?: string | null;
    workflowId?: string | null;
    polledCostCents?: number | null;
    polledCostEvents?: number | null;
    nodeStates?: NodeStateStub[];
    toolUsage?: ToolUsageGroup[];
  } = {},
) {
  const {
    runExists = true,
    status = 'completed',
    agentKind = 'claude',
    workflowId = null,
    polledCostCents = null,
    polledCostEvents = null,
    nodeStates = [],
    toolUsage = [],
  } = options;
  return new ChatWaterfallService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      timelineSpine: () =>
        Promise.resolve(
          rows.map(({ seq, kind, nodeId, payload, secondsIn }) => ({
            seq,
            kind,
            role:
              kind === 'message'
                ? ((payload as { role?: string } | null)?.role ?? null)
                : null,
            nodeId,
            createdAt: at(secondsIn),
          })),
        ),
      waterfallPayloadRows: () =>
        Promise.resolve(
          rows
            .filter((r) => PAYLOAD_KINDS.has(r.kind))
            .map(({ seq, kind, nodeId, payload, secondsIn }) => ({
              seq,
              kind,
              nodeId,
              payload: JSON.stringify(payload),
              createdAt: at(secondsIn),
            })),
        ),
      toolUsage: () => Promise.resolve(toolUsage),
    } as unknown as ItemDao,
    {
      listByRun: () =>
        Promise.resolve(
          nodeStates.map((state) => ({
            polledCostCents: null,
            polledCostEvents: null,
            ...state,
          })),
        ),
    } as unknown as NodeStateDao,
    {
      getById: () =>
        Promise.resolve(
          runExists
            ? {
                status,
                agentKind,
                workflowId,
                polledCostCents,
                polledCostEvents,
              }
            : null,
        ),
    } as unknown as RunDao,
    // cursor-agent is the one CLI here whose money is polled, as it is in the
    // shipped registry.
    {
      pollsSpend: (kind: string | null) => kind === 'cursor-agent',
    } as unknown as PolledSpendService,
  );
}

describe('ChatWaterfallService', () => {
  it('refuses a run that does not exist', async () => {
    await expect(build([], { runExists: false }).read('nope')).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('turn spans', () => {
    it("reaches BACK from the row that closed the turn by the CLI's own duration", async () => {
      // A turn_complete records the END. Drawing the span forward from it puts
      // every turn on the card at the wrong place — a defect that looks like a
      // plausible picture, which is why this asserts the computed start rather
      // than merely that a span exists.
      const result = await build([
        row(0, 'turn_complete', { usage: { durationMs: 30_000 } }, 100),
      ]).read('run-a');

      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]?.startedAt).toBe(iso(70));
      expect(result.turns[0]?.durationMs).toBe(30_000);
    });

    it("measures a turn from its lane's rows when the CLI reported no timing", async () => {
      // REVERSES an earlier pin that asserted such a turn was DROPPED. Every
      // ACP agent reports no timing at all, so dropping meant a cursor
      // callee's lane drew nothing and counted nothing while its caller drew a
      // long bar waiting on it — the picture said the agent had never run.
      // Measured on a real workflow run whose `qa` node holds two
      // `turn_complete` rows, both with `durationMs: null`, beside 130 tool
      // calls.
      const result = await build([
        row(0, 'tool_call', null, 4, 'qa'),
        row(1, 'turn_complete', { usage: { costUsd: 1.5 } }, 10, 'qa'),
      ]).read('run-a');

      expect(result.turns).toHaveLength(1);
      // From the lane's previous row (4s) to the turn's end (10s).
      expect(result.turns[0]?.durationMs).toBe(6_000);
      expect(result.turns[0]?.startedAt).toBe(iso(4));
      expect(result.turns[0]?.timingSource).toBe('derived');
    });

    it('invents nothing when the lane wrote nothing before its turn ended', async () => {
      // No previous row is no evidence of a stretch. Stretching the span to the
      // run's own start would draw a figure nobody measured, which is the whole
      // reason the derived case is bounded by a row rather than by the clock.
      const result = await build([
        row(0, 'turn_complete', { usage: { costUsd: 1.5 } }, 10, 'qa'),
      ]).read('run-a');

      expect(result.turns).toHaveLength(0);
    });

    it("counts a lane's turns from its ROWS, not from the spans it can draw", async () => {
      // The defect this exists for, stated as a figure: `qa` reported two
      // finished turns and 130 tool calls, and the card said `0 turns` because
      // neither turn could be drawn.
      const result = await build([
        row(0, 'tool_call', null, 1, 'qa'),
        row(1, 'turn_complete', { usage: { costUsd: 1 } }, 2, 'qa'),
        row(2, 'turn_complete', { usage: { costUsd: 1 } }, 3, 'qa'),
      ]).read('run-a');

      const qa = result.lanes.find((lane) => lane.nodeId === 'qa');
      expect(qa?.turns).toBe(2);
      // And the CLI still measured nothing, so this stays unmeasured rather
      // than becoming the sum of the spans the card drew.
      expect(qa?.workedMs).toBeNull();
    });

    it('counts a turn a cancel cut off before it could report', async () => {
      // The same contradiction from the other end, and the one REPORTED: a
      // `turn_complete` is written when a turn ENDS, so a run stopped mid-turn
      // leaves none — and the lane read `0 turns` beside the 136 tool calls
      // that turn had just made. The status row recording the OPEN is the only
      // trace of it left.
      const result = await build([
        row(0, 'status', { nodeId: 'eng', status: 'running' }, 1, 'eng'),
        row(1, 'tool_call', null, 2, 'eng'),
        row(2, 'status', { nodeId: 'eng', status: 'cancelled' }, 3, 'eng'),
      ]).read('run-a');

      const eng = result.lanes.find((lane) => lane.nodeId === 'eng');
      expect(eng?.turns).toBe(1);
      // A cancelled turn reported no figures, and a lane is never invented
      // from a status row alone — this one exists because it called a tool.
      expect(eng?.workedMs).toBeNull();
      expect(eng?.costUsd).toBeNull();
    });

    it('never counts one turn twice when both rows record it', async () => {
      // A workflow writes BOTH — the open and the completion — so summing the
      // two channels would double every turn a workflow node finished.
      const result = await build([
        row(0, 'status', { nodeId: 'eng', status: 'running' }, 1, 'eng'),
        row(1, 'tool_call', null, 2, 'eng'),
        row(2, 'turn_complete', { usage: { costUsd: 1 } }, 3, 'eng'),
      ]).read('run-a');

      expect(result.lanes.find((lane) => lane.nodeId === 'eng')?.turns).toBe(1);
    });

    it('opens no lane for a node that only ever reported a status', async () => {
      // A status row is evidence a turn began, never evidence of WORK — and a
      // lane drawn from one alone would be an empty row on the card.
      const result = await build([
        row(0, 'status', { nodeId: 'ghost', status: 'running' }, 1, 'ghost'),
        row(1, 'tool_call', null, 2, 'eng'),
      ]).read('run-a');

      expect(result.lanes.map((lane) => lane.nodeId)).toEqual(['eng']);
    });

    it('reports which tools a lane called, and how often', async () => {
      const result = await build([row(0, 'tool_call', null, 1, 'eng')], {
        toolUsage: [
          { nodeId: 'eng', name: 'Bash', toolKind: 'execute', calls: 8939 },
          { nodeId: 'eng', name: 'Read', toolKind: 'read', calls: 2672 },
        ],
      }).read('run-a');

      expect(result.toolUse).toEqual([
        { nodeId: 'eng', name: 'Bash', calls: 8939 },
        { nodeId: 'eng', name: 'Read', calls: 2672 },
      ]);
    });

    it('folds a CLI that titles each call after its arguments into one row', async () => {
      // The ACP transport names a `tool_call` with the CLI's own title, so on
      // a real cursor lane 64 shell calls arrived as 64 "tools" — and the
      // longest of them, at 37,630 characters, was past the wire's label cap,
      // which failed the whole response with a 500. Both halves are pinned
      // here because the fold is the only thing standing between them and the
      // card: the rows come straight from SQLite as the CLI wrote them.
      const result = await build([row(0, 'tool_call', null, 1, 'qa')], {
        toolUsage: [
          {
            nodeId: 'qa',
            name: `\`${'gh pr view 5251 --json body '.repeat(40)}\``,
            toolKind: 'execute',
            calls: 1,
          },
          {
            nodeId: 'qa',
            name: '`pnpm build`',
            toolKind: 'execute',
            calls: 1,
          },
          { nodeId: 'qa', name: 'Read File', toolKind: 'read', calls: 40 },
        ],
      }).read('run-a');

      expect(result.toolUse).toEqual([
        { nodeId: 'qa', name: 'Read File', calls: 40 },
        { nodeId: 'qa', name: 'execute', calls: 2 },
      ]);
      expect(
        RunWaterfallWireSchema.safeParse(result).success,
        'the response must satisfy its own wire schema',
      ).toBe(true);
    });
  });

  describe('turns that did not finish', () => {
    const callStarted = (seq: number, secondsIn: number): StoredRow =>
      row(
        seq,
        'call_started',
        {
          callId: 'call-4',
          callerNodeId: 'manager',
          calleeNodeId: 'engineer',
          mode: 'async',
        },
        secondsIn,
        'manager',
      );
    const engineerStatus = (
      seq: number,
      status: string,
      secondsIn: number,
    ): StoredRow =>
      row(
        seq,
        'status',
        { nodeId: 'engineer', status, callId: 'call-4' },
        secondsIn,
        'engineer',
      );

    it("draws a callee's turn that is still running, and the call its caller is waiting on", async () => {
      // The REPORTED shape, reconstructed from the reporter's own run: an
      // Engineer called at 66m was still working when the card was opened, so
      // neither its turn nor the call had an ending row — and the lane showed
      // `1 turn · 30 tools` over nothing but the density strip.
      const result = await build(
        [
          row(0, 'tool_call', null, 0, 'manager'),
          callStarted(1, 100),
          engineerStatus(2, 'running', 100),
          row(3, 'tool_call', null, 150, 'engineer'),
          row(4, 'tool_call', null, 400, 'engineer'),
        ],
        { status: 'running', workflowId: 'dev-team' },
      ).read('run-a');

      const engineer = result.turns.filter((t) => t.nodeId === 'engineer');
      expect(engineer).toHaveLength(1);
      expect(engineer[0]).toMatchObject({
        outcome: 'running',
        timingSource: 'derived',
        startedAt: iso(100),
        durationMs: 300_000,
        toolCalls: 2,
        costUsd: null,
      });
      expect(result.calls).toEqual([
        {
          callerNodeId: 'manager',
          calleeNodeId: 'engineer',
          mode: 'async',
          status: null,
          running: true,
          startedAt: iso(100),
          durationMs: 300_000,
        },
      ]);
      expect(
        RunWaterfallWireSchema.safeParse(result).success,
        'the response must satisfy its own wire schema',
      ).toBe(true);
    });

    it('opens a lane for a turn still running before it has called a tool', async () => {
      const result = await build(
        [
          row(0, 'tool_call', null, 0, 'manager'),
          engineerStatus(1, 'running', 10),
          row(2, 'tool_call', null, 20, 'manager'),
        ],
        { status: 'running', workflowId: 'dev-team' },
      ).read('run-a');

      expect(result.lanes.map((lane) => lane.nodeId)).toEqual([
        'manager',
        'engineer',
      ]);
    });

    it('draws nothing still open on a run that has settled', async () => {
      // An open bracket on a settled run is a record that lost its ending,
      // not work in progress — drawing it to the last row would be a claim
      // about a stretch nobody measured.
      const result = await build(
        [
          callStarted(0, 0),
          engineerStatus(1, 'running', 0),
          row(2, 'tool_call', null, 50, 'engineer'),
        ],
        { status: 'completed', workflowId: 'dev-team' },
      ).read('run-a');

      expect(result.turns).toHaveLength(0);
      expect(result.calls).toHaveLength(0);
    });

    it('draws a turn that failed, bracketed by its status rows', async () => {
      // A failed turn writes an `error` and a `failed` status, never a
      // `turn_complete`, so it used to vanish from the card entirely.
      const result = await build(
        [
          engineerStatus(0, 'running', 10),
          row(1, 'tool_call', null, 20, 'engineer'),
          engineerStatus(2, 'failed', 70),
        ],
        { workflowId: 'dev-team' },
      ).read('run-a');

      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        nodeId: 'engineer',
        outcome: 'failed',
        startedAt: iso(10),
        durationMs: 60_000,
        toolCalls: 1,
      });
    });

    it('never draws a reported turn a second time from its status rows', async () => {
      const result = await build(
        [
          engineerStatus(0, 'running', 10),
          row(1, 'tool_call', null, 20, 'engineer'),
          row(
            2,
            'turn_complete',
            { usage: { durationMs: 50_000 }, callId: 'call-4' },
            60,
            'engineer',
          ),
          engineerStatus(3, 'completed', 60),
        ],
        { workflowId: 'dev-team' },
      ).read('run-a');

      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        outcome: 'completed',
        timingSource: 'cli',
      });
    });

    it("keys a node's concurrent calls apart, so one call's turn cannot hide another's failure", async () => {
      const status = (
        seq: number,
        callId: string,
        value: string,
        secondsIn: number,
      ): StoredRow =>
        row(
          seq,
          'status',
          { nodeId: 'engineer', status: value, callId },
          secondsIn,
          'engineer',
        );
      const result = await build(
        [
          status(0, 'call-1', 'running', 0),
          status(1, 'call-2', 'running', 5),
          row(2, 'tool_call', null, 6, 'engineer'),
          row(
            3,
            'turn_complete',
            { usage: { durationMs: 20_000 }, callId: 'call-1' },
            20,
            'engineer',
          ),
          status(4, 'call-1', 'completed', 20),
          status(5, 'call-2', 'failed', 30),
        ],
        { workflowId: 'dev-team' },
      ).read('run-a');

      expect(result.turns.map((turn) => turn.outcome)).toEqual([
        'completed',
        'failed',
      ]);
    });

    it("draws a chat's turn in progress from the user's message, and a cancelled one to its cancel", async () => {
      const result = await build(
        [
          row(0, 'message', { role: 'user' }, 0),
          row(1, 'tool_call', null, 5),
          row(2, 'turn_cancelled', null, 10),
          row(3, 'message', { role: 'user' }, 20),
          row(4, 'tool_call', null, 25),
        ],
        { status: 'running' },
      ).read('run-a');

      expect(
        result.turns.map(({ outcome, startedAt, durationMs, toolCalls }) => ({
          outcome,
          startedAt,
          durationMs,
          toolCalls,
        })),
      ).toEqual([
        {
          outcome: 'cancelled',
          startedAt: iso(0),
          durationMs: 10_000,
          toolCalls: 1,
        },
        {
          outcome: 'running',
          startedAt: iso(20),
          durationMs: 5_000,
          toolCalls: 1,
        },
      ]);
    });
  });

  describe('the money rule', () => {
    it('reports a lane whose turns priced nothing as null, never as free', async () => {
      // This IS the cursor-agent lane: it works, it reports no price, and
      // summing its silence to 0 would tell the user the work was free.
      const result = await build(
        [
          row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 5, 'qa'),
          row(
            1,
            'turn_complete',
            { usage: { durationMs: 1_000, costUsd: 2 } },
            6,
            'eng',
          ),
        ],
        {
          nodeStates: [
            { nodeId: 'qa', agentKind: 'cursor-agent' },
            { nodeId: 'eng', agentKind: 'claude' },
          ],
        },
      ).read('run-a');

      const qa = result.lanes.find((lane) => lane.nodeId === 'qa');
      const eng = result.lanes.find((lane) => lane.nodeId === 'eng');
      expect(qa?.costUsd).toBeNull();
      expect(eng?.costUsd).toBe(2);
    });

    it('answers null for a run nobody was ever asked to approve', async () => {
      // Null and 0 are different answers here: "the run never stopped for
      // anybody" against "every card came back instantly".
      const quiet = await build([
        row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 1),
      ]).read('run-a');
      expect(quiet.waitedOnUserMs).toBeNull();
    });
  });

  describe('paired spans', () => {
    it('pairs an approval with its verdict and leaves an unanswered card undrawn', async () => {
      // A card still on screen has no ENDED stretch. Closing it at the end of
      // the run would report a wait the user has not finished waiting.
      const result = await build([
        row(0, 'approval_request', { id: 'a', toolName: 'Bash' }, 10),
        row(1, 'approval_verdict', { id: 'a', allow: true }, 40),
        row(2, 'approval_request', { id: 'b', toolName: 'Edit' }, 50),
      ]).read('run-a');

      expect(result.waits).toHaveLength(1);
      expect(result.waits[0]?.durationMs).toBe(30_000);
      expect(result.waits[0]?.toolName).toBe('Bash');
      expect(result.waitedOnUserMs).toBe(30_000);
    });

    it("carries a failed call's own status through to the card", async () => {
      // The card marks a failed call, so the status has to survive the fold.
      const result = await build([
        row(
          0,
          'call_started',
          {
            callId: 'c1',
            callerNodeId: 'mgr',
            calleeNodeId: 'qa',
            mode: 'async',
          },
          0,
        ),
        row(1, 'call_result', { callId: 'c1', status: 'error' }, 12),
      ]).read('run-a');

      expect(result.calls).toEqual([
        {
          callerNodeId: 'mgr',
          calleeNodeId: 'qa',
          mode: 'async',
          status: 'error',
          running: false,
          startedAt: iso(0),
          durationMs: 12_000,
        },
      ]);
    });

    it('runs a delegate from its FIRST open announcement to its outcome', async () => {
      // A delegate is announced at launch and re-announced with facts as they
      // land; taking the latest open would shrink every delegate to its tail.
      const result = await build([
        row(0, 'subagent_info', { id: 'd1', backgroundOpen: true }, 0),
        row(1, 'subagent_info', { id: 'd1', backgroundOpen: true }, 5),
        row(
          2,
          'subagent_info',
          { id: 'd1', backgroundOutcome: 'completed' },
          20,
        ),
      ]).read('run-a');

      expect(result.delegates).toEqual([
        { nodeId: null, startedAt: iso(0), durationMs: 20_000 },
      ]);
    });
  });

  describe('the tool lane', () => {
    it("counts each turn's own tool calls inside its span, ends included", async () => {
      // The count replaced the density strip, so it has to say how much THIS
      // stretch did: the call before the turn opened and the one after it
      // closed belong to neither.
      const result = await build([
        row(0, 'tool_call', null, 5),
        row(1, 'tool_call', null, 10),
        row(2, 'tool_call', null, 20),
        row(3, 'tool_call', null, 30),
        row(4, 'turn_complete', { usage: { durationMs: 20_000 } }, 30),
        row(5, 'tool_call', null, 31),
      ]).read('run-a');

      expect(result.lanes[0]?.toolCalls).toBe(5);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]?.toolCalls).toBe(3);
    });

    it("gives a chat run's single lane the run row's own agent", async () => {
      // The fixture is the SHAPE A REAL CHAT HAS, and that is the whole point
      // of this case. `ChatService` files a chat's session under the `agent`
      // pseudo-node, so a chat that has ever run carries a node state — keyed
      // `agent`, with a NULL agent kind — while its items carry `nodeId: null`
      // and its lane is keyed null. An empty `nodeStates` here is what let the
      // shipped `nodeStates.length === 0` fallback look correct: measured on a
      // real profile, 191 chat runs hold one of these rows, so that branch
      // never fired and every chat's lane reported its agent as unknown.
      const result = await build(
        [row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 1)],
        {
          agentKind: 'claude',
          nodeStates: [{ nodeId: 'agent', agentKind: null }],
        },
      ).read('run-a');

      expect(result.lanes[0]?.nodeId).toBeNull();
      expect(result.lanes[0]?.agentKind).toBe('claude');
    });
  });

  it('answers an empty picture for a run that has produced no row yet', async () => {
    // A freshly created chat. Without this branch `from`/`to` are read off
    // `spine[0]!` and the route 500s on the commonest possible state.
    const result = await build([]).read('run-a');

    expect(result.lanes).toEqual([]);
    expect(result.turns).toEqual([]);
    expect(result.waitedOnUserMs).toBeNull();
    expect(result.partialReason).toBeNull();
    expect(result.from).toBe(result.to);
  });

  it('opens no lane for the rows a workflow files under no node', async () => {
    // A workflow run persists its seed message and its terminal row with
    // `nodeId: null`. Opening a lane for every spine row drew those as an empty
    // lane named `agent` beside the real ones, taking the first colour.
    const result = await build(
      [
        row(0, 'message', { text: 'the brief' }, 0),
        row(1, 'tool_call', null, 5, 'engineer'),
        row(
          2,
          'turn_complete',
          { usage: { durationMs: 1_000 } },
          6,
          'engineer',
        ),
        // The run-level terminal row: a turn_complete under no node, with no
        // duration of its own.
        row(3, 'turn_complete', { stopReason: 'end_turn' }, 7),
      ],
      {
        workflowId: 'wf',
        nodeStates: [{ nodeId: 'engineer', agentKind: 'claude' }],
      },
    ).read('run-a');

    expect(result.lanes.map((lane) => lane.nodeId)).toEqual(['engineer']);
  });

  it("reports a cursor chat's polled price rather than its silent turns", async () => {
    // cursor-agent prices nothing on its own wire, so the raw sum is null while
    // the app already knows the figure and shows it elsewhere.
    //
    // Carries the chat's REAL node state, for the reason its sibling above
    // states at length — and this is the case where getting that wrong costs
    // money rather than a label: with the lane's polled bill missing, a cursor
    // chat draws a lane reading `—` under a total carrying the real figure.
    const result = await build(
      [row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 1)],
      {
        agentKind: 'cursor-agent',
        polledCostCents: 729,
        polledCostEvents: 3,
        nodeStates: [{ nodeId: 'agent', agentKind: null }],
      },
    ).read('run-a');

    expect(result.totals.costUsd).toBeCloseTo(7.29, 5);
    expect(result.lanes[0]?.costUsd).toBeCloseTo(7.29, 5);
  });

  it("adds a workflow's cursor node bill on top of the turns another CLI priced", async () => {
    // Replacing here would report the cursor node's bill as the whole run's.
    const result = await build(
      [
        row(
          0,
          'turn_complete',
          { usage: { durationMs: 1_000, costUsd: 2 } },
          1,
          'eng',
        ),
        row(1, 'turn_complete', { usage: { durationMs: 1_000 } }, 2, 'qa'),
      ],
      {
        workflowId: 'wf',
        nodeStates: [
          { nodeId: 'eng', agentKind: 'claude' },
          {
            nodeId: 'qa',
            agentKind: 'cursor-agent',
            polledCostCents: 100,
            polledCostEvents: 1,
          },
        ],
      },
    ).read('run-a');

    expect(result.totals.costUsd).toBeCloseTo(3, 5);
    expect(
      result.lanes.find((lane) => lane.nodeId === 'qa')?.costUsd,
    ).toBeCloseTo(1, 5);
  });

  it('calls a host-raised card a question, though the CLI set no flag', async () => {
    // A question asked through geniro's own `ask_user_question` names the tool
    // and sets no `requiresUserInteraction`, so reading the flag alone labelled
    // every one of them a permission request — the opposite of what the field
    // documents.
    const result = await build([
      row(0, 'approval_request', { id: 'a', toolName: 'ask_user_question' }, 0),
      row(1, 'approval_verdict', { id: 'a', allow: true }, 30),
    ]).read('run-a');

    expect(result.waits[0]?.question).toBe(true);
  });

  it('pins every field of a wait span, not only its length', async () => {
    const result = await build([
      row(
        0,
        'approval_request',
        { id: 'a', toolName: 'Bash', requiresUserInteraction: true },
        10,
        'manager',
      ),
      row(1, 'approval_verdict', { id: 'a', allow: false }, 40),
    ]).read('run-a');

    expect(result.waits).toEqual([
      {
        nodeId: 'manager',
        question: true,
        toolName: 'Bash',
        allowed: false,
        startedAt: iso(10),
        durationMs: 30_000,
      },
    ]);
  });

  it('drops a turn whose reported duration is past what a span can hold', async () => {
    // `new Date` throws past its range, and the throw is uncaught in `read` —
    // so one absurd figure would fail the whole card where every other unusable
    // one costs a single span.
    const result = await build([
      row(0, 'turn_complete', { usage: { durationMs: 1e16 } }, 10),
      row(1, 'turn_complete', { usage: { durationMs: 2_000 } }, 20),
    ]).read('run-a');

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.durationMs).toBe(2_000);
  });

  it('closes a delegate on its OUTCOME even when the row still says open', async () => {
    // The documented ranking: a stated outcome outranks `backgroundOpen`,
    // because a backgrounded delegate's launching call is answered within the
    // second and the outcome is the only field that speaks about the work.
    // Reading the flag first left such a row open here and closed everywhere
    // else.
    const result = await build([
      row(0, 'subagent_info', { id: 'd1', backgroundOpen: true }, 0),
      row(
        1,
        'subagent_info',
        { id: 'd1', backgroundOpen: true, backgroundOutcome: 'completed' },
        15,
      ),
    ]).read('run-a');

    expect(result.delegates).toEqual([
      { nodeId: null, startedAt: iso(0), durationMs: 15_000 },
    ]);
  });

  it('says so when it caps a run that holds more than the card can draw', async () => {
    const many = Array.from({ length: 520 }, (_, index) =>
      row(index, 'turn_complete', { usage: { durationMs: 1_000 } }, index),
    );

    const result = await build(many).read('run-a');

    expect(result.turns).toHaveLength(500);
    expect(result.partialReason).toContain('turns');
    // The NEWEST are kept and stay in order — a reversed tail would draw the
    // run backwards rather than shortening it.
    expect(result.turns[0]?.startedAt).toBe(iso(19));
    expect(result.turns.at(-1)?.startedAt).toBe(iso(518));
  });
});
