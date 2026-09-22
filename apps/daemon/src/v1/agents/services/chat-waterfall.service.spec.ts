import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import { ChatWaterfallService } from './chat-waterfall.service';

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
]);

interface NodeStateStub {
  nodeId: string;
  agentKind: string | null;
  cursorCostCents?: number | null;
  cursorCostEvents?: number | null;
}

function build(
  rows: StoredRow[],
  options: {
    runExists?: boolean;
    agentKind?: string | null;
    workflowId?: string | null;
    cursorCostCents?: number | null;
    cursorCostEvents?: number | null;
    nodeStates?: NodeStateStub[];
  } = {},
) {
  const {
    runExists = true,
    agentKind = 'claude',
    workflowId = null,
    cursorCostCents = null,
    cursorCostEvents = null,
    nodeStates = [],
  } = options;
  return new ChatWaterfallService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      timelineSpine: () =>
        Promise.resolve(
          rows.map(({ seq, kind, nodeId, secondsIn }) => ({
            seq,
            kind,
            role: null,
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
    } as unknown as ItemDao,
    {
      listByRun: () =>
        Promise.resolve(
          nodeStates.map((state) => ({
            cursorCostCents: null,
            cursorCostEvents: null,
            ...state,
          })),
        ),
    } as unknown as NodeStateDao,
    {
      getById: () =>
        Promise.resolve(
          runExists
            ? { agentKind, workflowId, cursorCostCents, cursorCostEvents }
            : null,
        ),
    } as unknown as RunDao,
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

    it('drops a turn whose CLI reported no duration instead of drawing it', async () => {
      // cursor-agent reports none. A zero-width span, or one stretched to the
      // wall clock, would put a figure on the card that nothing measured.
      const result = await build([
        row(0, 'turn_complete', { usage: { costUsd: 1.5 } }, 10),
        row(1, 'turn_complete', { usage: { durationMs: 5_000 } }, 20),
      ]).read('run-a');

      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]?.durationMs).toBe(5_000);
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
    it('counts tool calls into buckets across the run, from the payload-free spine', async () => {
      const result = await build([
        row(0, 'tool_call', null, 0),
        row(1, 'tool_call', null, 0),
        row(2, 'tool_call', null, 100),
        row(3, 'turn_complete', { usage: { durationMs: 1_000 } }, 100),
      ]).read('run-a');

      const [lane] = result.lanes;
      expect(lane?.toolCalls).toBe(3);
      expect(lane?.toolBuckets[0]).toBe(2);
      // The run's last instant belongs to the LAST slice, not one past the end.
      expect(lane?.toolBuckets.at(-1)).toBe(1);
      expect(lane?.toolBuckets.reduce((a, b) => a + b, 0)).toBe(3);
    });

    it("gives a chat run's single lane the run row's own agent", async () => {
      // A chat has no node states, so without this fallback every chat card
      // would report its agent as unknown while naming the model it ran.
      const result = await build(
        [row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 1)],
        { agentKind: 'claude' },
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
    const result = await build(
      [row(0, 'turn_complete', { usage: { durationMs: 1_000 } }, 1)],
      { agentKind: 'cursor-agent', cursorCostCents: 729, cursorCostEvents: 3 },
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
            cursorCostCents: 100,
            cursorCostEvents: 1,
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
