import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { AgentKind } from '../../runs/runs.types';
import type {
  RunWaterfallCall,
  RunWaterfallDelegate,
  RunWaterfallLane,
  RunWaterfallTurn,
  RunWaterfallWait,
  RunWaterfallWire,
} from '../chat.types';
import type { ChatTotalsWire } from '../chat.types';
import { HOST_QUESTION_TOOL } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { isUserQuestion } from '../utils/approval-answer';
import {
  addPolledCursorSpend,
  applyCursorSpend,
  nodeCursorSpend,
  type PolledCursorSpend,
} from '../utils/cursor-usage';
import { asBoolean, asNumber, asRecord, asString } from '../utils/json-util';
import { delegateIdOf } from '../utils/open-delegates';
import { foldToolUsage } from '../utils/tool-usage';
import { sumUsagePayloads } from '../utils/usage-figures';

/**
 * How many slices the tool lane is cut into.
 *
 * The lane is a density strip a couple of hundred pixels wide, so the bucket
 * count is a drawing decision rather than a data one: finer than the strip can
 * resolve costs wire bytes nobody can see.
 */
const TOOL_BUCKETS = 180;

/**
 * How many spans of each kind one card carries.
 *
 * Generous rather than tight, on `ChatTimelineService`'s reasoning: a real run
 * sits orders of magnitude inside this. What the bound buys is that the response
 * cannot grow without limit, and a run that trips it SAYS so.
 */
const MAX_SPANS_PER_KIND = 500;

/**
 * The longest span this card will draw, in milliseconds — a fortnight.
 *
 * A bound on a figure an AGENT reported, not on anything geniro measured: a
 * value past the Date range makes the span arithmetic throw, and one merely
 * absurd would stretch a lane past every real turn on it. Longer than any run
 * anyone has held open, so a truthful figure is never refused.
 */
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How many (lane, tool) pairs the tool breakdown carries.
 *
 * A run reaches a couple of dozen distinct tools; the bound exists so one that
 * loads forty MCP servers cannot grow the response without limit, and tripping
 * it SAYS so through `partialReason` like every other cap here.
 */
const MAX_TOOL_NAMES = 60;

/**
 * How many GROUPS the engine may hand back before the fold collapses them.
 *
 * A separate and much larger bound than the one above, because the two count
 * different things: SQLite groups by the raw `payload.name`, and on the ACP
 * transport that is a per-CALL title — so a cursor node running a thousand
 * shell commands produces a thousand groups that fold into ONE row. The bound
 * is on the query's own answer, and tripping it says so like every other cap
 * here.
 */
const MAX_TOOL_GROUPS = 2_000;

/**
 * One run as money, order and timing on a single wall clock.
 *
 * Its own service rather than another method on `ChatService`, on
 * `ChatTimelineService`'s rule: this reads two projections and folds them, and
 * that class already owns turn execution.
 *
 * Every figure it reports comes from rows geniro already stores — nothing here
 * measures anything new, and the money rule is imported rather than restated
 * (`usage-figures.ts`), because two copies of "null means NOT MEASURED" is how
 * this card and the Stats page come to disagree about the same turns.
 */
@Injectable()
export class ChatWaterfallService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly runDao: RunDao,
  ) {}

  async read(runId: string): Promise<RunWaterfallWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    const [spine, payloadRows, nodeStates, toolUse] = await Promise.all([
      this.itemDao.timelineSpine(runId, em),
      this.itemDao.waterfallPayloadRows(runId, em),
      this.nodeStateDao.listByRun(runId, em),
      this.itemDao.toolUsage(runId, MAX_TOOL_GROUPS + 1, em),
    ]);

    if (spine.length === 0) {
      return empty();
    }
    const from = spine[0]!.createdAt.getTime();
    const to = spine[spine.length - 1]!.createdAt.getTime();

    const turns = foldTurns(payloadRows, laneRowTimes(spine));
    const calls = foldCalls(payloadRows);
    const waits = foldWaits(payloadRows);
    const delegates = foldDelegates(payloadRows);
    // A CHAT is decided by the run, never by the emptiness of `nodeStates` —
    // and that distinction is the whole of a defect this shipped with.
    //
    // A chat DOES carry a node state: `ChatService` files its session under the
    // `agent` pseudo-node, so `nodeStates` is non-empty for every chat that has
    // ever run (measured on a real profile: 191 of them), while its ITEMS carry
    // `nodeId: null` and its lane is therefore keyed null. So the old
    // `nodeStates.length === 0` guard never fired, and the map it was meant to
    // seed was keyed `agent` against a lane asking for null.
    //
    // The visible half was a lane labelled `—` instead of `claude`. The half
    // that matters is the second fallback: a cursor chat prices no turn on the
    // wire, so without the run's polled bill its lane reads as costing nothing
    // under a total that carries the real figure — the exact "$0.00 about money
    // nobody measured" this card exists to refuse.
    const isChat = run.workflowId === null;
    const agentKinds = new Map<string | null, AgentKind | null>(
      nodeStates.map((state) => [state.nodeId, state.agentKind]),
    );

    const cursorNodes = nodeStates.filter(
      (state) => state.agentKind === AgentKind.CursorAgent,
    );
    const polledByNode = new Map<string | null, PolledCursorSpend>(
      cursorNodes.map((state) => [
        state.nodeId,
        nodeCursorSpend(state, run, cursorNodes.length),
      ]),
    );
    // A chat produces exactly ONE lane, so the run row answers for it whatever
    // key that lane ended up under — which is what keeps this independent of
    // the sentinel a chat's rows happen to be filed under.
    if (isChat) {
      agentKinds.set(null, run.agentKind);
      if (run.agentKind === AgentKind.CursorAgent) {
        polledByNode.set(null, run);
      }
    }

    const lanes = foldLanes({
      spine,
      turnStarts: laneTurnStarts(payloadRows),
      turns,
      agentKinds,
      polledByNode,
      from,
      to,
    });

    const capped: string[] = [];
    const cap = <T>(list: T[], name: string): T[] => {
      if (list.length <= MAX_SPANS_PER_KIND) {
        return list;
      }
      capped.push(name);
      // The NEWEST are kept and stay in order: the card reads left to right
      // through the run, so returning the tail reversed would draw it backwards.
      return list.slice(-MAX_SPANS_PER_KIND);
    };

    const tools = foldToolUsage(toolUse, MAX_TOOL_NAMES);
    if (tools.capped || toolUse.length > MAX_TOOL_GROUPS) {
      capped.push('tools');
    }

    const waitedMs = waits.reduce((sum, wait) => sum + wait.durationMs, 0);
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      lanes,
      toolUse: tools.toolUse,
      turns: cap(turns, 'turns'),
      calls: cap(calls, 'calls'),
      waits: cap(waits, 'waits'),
      delegates: cap(delegates, 'delegates'),
      // cursor-agent prices no turn on its own wire — its only price is the
      // one polled onto the run and node rows — so the raw sum would report a
      // cursor run as costing nothing while the panel beside this card shows
      // the real figure. Which helper applies is the split `ChatMetricsService`
      // already makes: a cursor-only chat has nothing to add the bill TO, so it
      // REPLACES, while a workflow's claude nodes priced their own turns and
      // the cursor node's bill goes on top.
      totals: withCursorSpend(
        sumUsagePayloads(
          payloadRows
            .filter((row) => row.kind === 'turn_complete')
            .map((row) => row.payload),
        ),
        run,
        [...polledByNode.values()],
      ),
      // Null rather than 0 when nothing was ever asked: "the run never stopped
      // for anybody" and "every card was answered instantly" are different
      // facts, and only one of them is worth a tile.
      waitedOnUserMs: waits.length === 0 ? null : waitedMs,
      partialReason:
        capped.length === 0
          ? null
          : `showing the newest ${MAX_SPANS_PER_KIND} of this run's ${capped.join(' and ')} — it holds more than the card can draw`,
    };
  }
}

type PayloadRow = {
  seq: number;
  kind: string;
  payload: string;
  nodeId: string | null;
  createdAt: Date;
};

type SpineRow = {
  seq: number;
  kind: string;
  role: string | null;
  nodeId: string | null;
  createdAt: Date;
};

function empty(): RunWaterfallWire {
  const now = new Date().toISOString();
  return {
    from: now,
    to: now,
    lanes: [],
    toolUse: [],
    turns: [],
    calls: [],
    waits: [],
    delegates: [],
    totals: sumUsagePayloads([]),
    waitedOnUserMs: null,
    partialReason: null,
  };
}

/**
 * The run's totals with whatever cursor-agent charged folded in.
 *
 * A chat REPLACES and a workflow ADDS, which is not a shortcut either way: a
 * cursor-only chat's own turns report no price at all, so there is nothing to
 * add a bill to, while a workflow's other nodes priced their turns and
 * replacing would report the cursor node's bill as the whole run's cost.
 */
function withCursorSpend(
  totals: ChatTotalsWire,
  run: { workflowId: string | null } & PolledCursorSpend,
  perNode: readonly PolledCursorSpend[],
): ChatTotalsWire {
  if (run.workflowId === null) {
    return applyCursorSpend(totals, run);
  }
  return perNode.reduce(
    (carried, polled) => addPolledCursorSpend(carried, polled),
    totals,
  );
}

/** A polled cursor bill in dollars, or null when nothing was ever priced. */
function polledCents(spend: PolledCursorSpend | undefined): number | null {
  if (spend === undefined || spend.cursorCostCents === null) {
    return null;
  }
  return (spend.cursorCostEvents ?? 0) === 0
    ? null
    : spend.cursorCostCents / 100;
}

function parsed(payload: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * A turn's span reaches BACK from the row that closed it.
 *
 * `turn_complete` records the end, and the only honest start is that end minus
 * the CLI's own working time. A turn whose CLI reported no duration is dropped
 * rather than drawn at zero width or stretched to a wall clock it never claimed
 * — cursor-agent reports none, and inventing one would put its turns on the
 * card as facts nothing measured.
 */
function foldTurns(
  rows: readonly PayloadRow[],
  laneRowTimes: ReadonlyMap<string | null, number[]>,
): RunWaterfallTurn[] {
  const out: RunWaterfallTurn[] = [];
  for (const row of rows) {
    if (row.kind !== 'turn_complete') {
      continue;
    }
    const usage = asRecord(parsed(row.payload)?.usage);
    if (usage === null) {
      continue;
    }
    const endedMs = row.createdAt.getTime();
    const reported = asNumber(usage.durationMs);
    // Bounded at BOTH ends. `asNumber` admits any finite number, and a figure
    // past this range makes `new Date` throw `RangeError` — which, uncaught,
    // fails the whole card on one bad row where every other unusable figure
    // here costs a single span.
    const usable =
      reported !== null && reported > 0 && reported <= MAX_SPAN_MS
        ? reported
        : null;
    // A turn the CLI did not time is MEASURED FROM THE ROWS rather than
    // dropped. Every ACP agent reports no timing at all, so dropping meant a
    // cursor callee's lane drew nothing and counted nothing while its caller
    // drew a long bar waiting on it — the picture said the agent had not run.
    const derived = usable === null ? derivedSpan(laneRowTimes, row) : null;
    const durationMs = usable ?? derived;
    if (durationMs === null) {
      continue;
    }
    out.push({
      nodeId: row.nodeId,
      startedAt: new Date(endedMs - durationMs).toISOString(),
      timingSource: usable === null ? 'derived' : 'cli',
      durationMs,
      apiMs: asNumber(usage.apiMs),
      ttftMs: asNumber(usage.ttftMs),
      timeToRequestMs: asNumber(usage.timeToRequestMs),
      numTurns: asNumber(usage.numTurns),
      costUsd: asNumber(usage.costUsd),
      model: asString(usage.contextModel),
      inputTokens: asNumber(usage.inputTokens),
      outputTokens: asNumber(usage.outputTokens),
      cacheReadTokens: asNumber(usage.cacheReadTokens),
      contextTokens: asNumber(usage.contextTokens),
      contextWindowTokens: asNumber(usage.contextWindowTokens),
    });
  }
  return out;
}

/**
 * When each lane wrote something, in order — the evidence a derived span reads.
 *
 * Built off the SPINE, which carries no payload, so this costs nothing beyond
 * the walk the fold already makes.
 */
function laneRowTimes(
  spine: readonly SpineRow[],
): Map<string | null, number[]> {
  const byLane = new Map<string | null, number[]>();
  for (const row of spine) {
    const at = row.createdAt.getTime();
    const own = byLane.get(row.nodeId);
    if (own === undefined) {
      byLane.set(row.nodeId, [at]);
    } else {
      own.push(at);
    }
  }
  return byLane;
}

/**
 * How long a turn took, measured from the rows its own lane wrote.
 *
 * The stretch runs from the lane's PREVIOUS row to this `turn_complete` — the
 * turn is, by definition, everything the agent did since it last stopped. The
 * renderer states this as derived rather than drawing it as the CLI's own
 * figure, and `workedMs` deliberately never includes it.
 *
 * Null when the lane wrote nothing before this row (its very first turn
 * produced no tool call, no message, nothing) — there is no evidence of a
 * stretch, so nothing is invented.
 */
function derivedSpan(
  laneRowTimes: ReadonlyMap<string | null, number[]>,
  row: PayloadRow,
): number | null {
  const times = laneRowTimes.get(row.nodeId);
  if (times === undefined) {
    return null;
  }
  const endedMs = row.createdAt.getTime();
  let previous: number | null = null;
  for (const at of times) {
    if (at >= endedMs) {
      break;
    }
    previous = at;
  }
  if (previous === null) {
    return null;
  }
  const span = endedMs - previous;
  return span > 0 && span <= MAX_SPAN_MS ? span : null;
}

/** `call_started` opens a span and the `call_result` carrying its id closes it. */
function foldCalls(rows: readonly PayloadRow[]): RunWaterfallCall[] {
  const open = new Map<
    string,
    { row: PayloadRow; body: Record<string, unknown> }
  >();
  const out: RunWaterfallCall[] = [];
  for (const row of rows) {
    const body = parsed(row.payload);
    const callId = asString(body?.callId);
    if (body === null || callId === null) {
      continue;
    }
    if (row.kind === 'call_started') {
      open.set(callId, { row, body });
      continue;
    }
    if (row.kind !== 'call_result') {
      continue;
    }
    const started = open.get(callId);
    if (started === undefined) {
      continue;
    }
    open.delete(callId);
    out.push({
      callerNodeId: asString(started.body.callerNodeId),
      calleeNodeId: asString(started.body.calleeNodeId),
      mode: asString(started.body.mode),
      status: asString(body.status),
      startedAt: started.row.createdAt.toISOString(),
      durationMs: Math.max(
        0,
        row.createdAt.getTime() - started.row.createdAt.getTime(),
      ),
    });
  }
  return out;
}

/**
 * An approval card and the verdict that answered it.
 *
 * A card the user never answered has no span: its stretch has not ended, and
 * drawing it to the end of the run would report a wait nobody has finished
 * waiting as though they had.
 */
function foldWaits(rows: readonly PayloadRow[]): RunWaterfallWait[] {
  const open = new Map<
    string,
    { row: PayloadRow; body: Record<string, unknown> }
  >();
  const out: RunWaterfallWait[] = [];
  for (const row of rows) {
    const body = parsed(row.payload);
    const id = asString(body?.id);
    if (body === null || id === null) {
      continue;
    }
    if (row.kind === 'approval_request') {
      open.set(id, { row, body });
      continue;
    }
    if (row.kind !== 'approval_verdict') {
      continue;
    }
    const started = open.get(id);
    if (started === undefined) {
      continue;
    }
    open.delete(id);
    out.push({
      nodeId: started.row.nodeId,
      // TWO ways a card is a question, because the two channels state it
      // differently: a CLI with a question tool of its own sets the flag, while
      // a question raised through geniro's own `ask_user_question` names that
      // tool and sets nothing — so reading the flag alone labelled every
      // host-raised question a permission request.
      question:
        asBoolean(started.body.requiresUserInteraction) === true ||
        isUserQuestion(
          HOST_QUESTION_TOOL,
          asString(started.body.toolName) ?? '',
        ),
      toolName: asString(started.body.toolName),
      allowed: asBoolean(body.allow),
      startedAt: started.row.createdAt.toISOString(),
      durationMs: Math.max(
        0,
        row.createdAt.getTime() - started.row.createdAt.getTime(),
      ),
    });
  }
  return out;
}

/**
 * A delegate runs from the announcement that opened it to the one that reported
 * its outcome — both of which are `subagent_info` rows carrying the same id.
 */
function foldDelegates(rows: readonly PayloadRow[]): RunWaterfallDelegate[] {
  const open = new Map<string, PayloadRow>();
  const out: RunWaterfallDelegate[] = [];
  for (const row of rows) {
    if (row.kind !== 'subagent_info') {
      continue;
    }
    const body = parsed(row.payload);
    // `delegateIdOf` rather than a second reading of the same field: it is the
    // exported rule the stranded-delegate fold and the renderer both key on,
    // and it refuses an empty id, which every row carrying one would otherwise
    // merge into a single phantom delegate.
    const id = delegateIdOf(body);
    if (body === null || id === null) {
      continue;
    }
    // OUTCOME FIRST, which is `open-delegates.ts`'s documented ranking and the
    // one the renderer mirrors: a backgrounded delegate's launching call is
    // answered within the second, so a stated outcome is the only field that
    // speaks about the WORK. Reading `backgroundOpen` first made a row
    // carrying both read as open here and closed everywhere else.
    const closed =
      asString(body.backgroundOutcome) !== null ||
      asBoolean(body.backgroundOpen) === false;
    if (!closed) {
      // The launch is announced once and then re-announced with facts as they
      // arrive, so the EARLIEST open is the start.
      if (asBoolean(body.backgroundOpen) === true && !open.has(id)) {
        open.set(id, row);
      }
      continue;
    }
    const started = open.get(id);
    if (started === undefined) {
      continue;
    }
    open.delete(id);
    out.push({
      nodeId: started.nodeId,
      startedAt: started.createdAt.toISOString(),
      durationMs: Math.max(
        0,
        row.createdAt.getTime() - started.createdAt.getTime(),
      ),
    });
  }
  return out;
}

/**
 * One lane per node that did anything, in the order the run first reached it.
 *
 * The tool density is read off the SPINE, which carries no payload — which is
 * what makes a lane affordable on a run holding thousands of tool calls.
 *
 * A DELEGATE's tool calls are therefore counted in the lane of the agent that
 * launched it: what separates the two is `payload.parentToolUseId`, and the
 * spine deliberately carries no payload, so the exclusion every sibling fold
 * applies is unreachable here without paying for the text column — the same
 * trade {@link ChatTimelineService} makes for its message count. It is answered
 * by the WORDING rather than by a filter: the card says `sub-agents included`
 * on that figure, because it sits directly under an agent card stating
 * `Run.toolCalls`, which is the agent's OWN toolbelt and is legitimately a
 * fraction of this one (measured on a fan-out thread: 237 against 636).
 */
/**
 * How many turns each lane OPENED, from the status rows that record one.
 *
 * A `turn_complete` is written when a turn ENDS, so a run cancelled mid-flight
 * leaves none — and the lane then reported `0 turns` beside the hundred and
 * thirty-six tool calls that turn had made, which is the contradiction this
 * answers. REPORTED as exactly that.
 *
 * Only the executor writes these: measured on a real install, every chat run
 * has zero `status` rows against hundreds of `turn_complete`s, so this is a
 * count of what a WORKFLOW recorded and never the whole answer — the caller
 * takes whichever channel saw more of the run.
 */
function laneTurnStarts(
  payloadRows: readonly PayloadRow[],
): Map<string | null, number> {
  const starts = new Map<string | null, number>();
  for (const row of payloadRows) {
    if (row.kind !== 'status') {
      continue;
    }
    if (asString(parsed(row.payload)?.status) !== 'running') {
      continue;
    }
    starts.set(row.nodeId, (starts.get(row.nodeId) ?? 0) + 1);
  }
  return starts;
}

function foldLanes(input: {
  spine: readonly SpineRow[];
  turnStarts: ReadonlyMap<string | null, number>;
  turns: readonly RunWaterfallTurn[];
  agentKinds: ReadonlyMap<string | null, AgentKind | null>;
  polledByNode: ReadonlyMap<string | null, PolledCursorSpend>;
  from: number;
  to: number;
}): RunWaterfallLane[] {
  const { spine, turnStarts, turns, agentKinds, polledByNode, from, to } =
    input;
  const span = Math.max(1, to - from);
  const lanes = new Map<
    string | null,
    { buckets: number[]; toolCalls: number; turnRows: number }
  >();
  const laneFor = (
    nodeId: string | null,
  ): { buckets: number[]; toolCalls: number; turnRows: number } => {
    const existing = lanes.get(nodeId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = {
      buckets: new Array<number>(TOOL_BUCKETS).fill(0),
      toolCalls: 0,
      turnRows: 0,
    };
    lanes.set(nodeId, fresh);
    return fresh;
  };

  for (const row of spine) {
    // A lane is opened by a row that IS work — a tool call or a finished turn.
    // Opening one for every row instead put a lane under the `nodeId: null` a
    // workflow run files its own seed message and terminal row under, which
    // drew an empty lane named `agent` beside the real ones. `turn_complete`
    // has to open one too: a node that only ever called an agent, with no tool
    // call of its own, still did something.
    if (row.kind !== 'tool_call' && row.kind !== 'turn_complete') {
      continue;
    }
    const lane = laneFor(row.nodeId);
    if (row.kind !== 'tool_call') {
      // Counted HERE, off the row, and never from the drawable spans: a CLI
      // that reports no timing has no span, and counting spans is what made a
      // cursor lane read `0 turns` beside its own 130 tool calls.
      lane.turnRows += 1;
      continue;
    }
    lane.toolCalls += 1;
    // Clamped at both ends before the write, so the index is always inside an
    // array built exactly TOOL_BUCKETS long: a row at `to` lands on the last
    // slice rather than one past it.
    const slot = Math.max(
      0,
      Math.min(
        TOOL_BUCKETS - 1,
        Math.floor(((row.createdAt.getTime() - from) / span) * TOOL_BUCKETS),
      ),
    );
    lane.buckets[slot] = lane.buckets[slot]! + 1;
  }

  return (
    [...lanes.entries()]
      .map(([nodeId, lane]) => {
        const own = turns.filter((turn) => turn.nodeId === nodeId);
        const costed = own.filter((turn) => turn.costUsd !== null);
        const timed = own.filter((turn) => turn.timingSource === 'cli');
        return {
          nodeId,
          agentKind: agentKinds.get(nodeId) ?? null,
          // A cursor lane's price is the POLLED one — that CLI reports none per
          // turn — and otherwise the lane's own turns. Null, not 0, when neither
          // exists: reporting unmeasured work as free is a claim about money
          // nothing made.
          costUsd:
            polledCents(polledByNode.get(nodeId)) ??
            (costed.length === 0
              ? null
              : costed.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)),
          // Whichever channel saw more of this lane's turns. They record
          // different moments — a status row when a turn OPENS (written by the
          // executor alone), a `turn_complete` when one ENDS — so neither is
          // the whole answer on its own: a chat writes no status row at all,
          // and a cancelled workflow node writes no completion. Taking the
          // larger is what keeps `0 turns · 136 tools` off the card without
          // inventing a turn: both figures are counts of rows the run really
          // wrote.
          turns: Math.max(lane.turnRows, turnStarts.get(nodeId) ?? 0),
          toolCalls: lane.toolCalls,
          // The CLI's OWN time only. A derived span is drawn so the lane is
          // visible; summing it here would report a measurement nobody made.
          workedMs:
            timed.length === 0
              ? null
              : timed.reduce((sum, turn) => sum + turn.durationMs, 0),
          toolBuckets: lane.buckets,
        } satisfies RunWaterfallLane;
      })
      // A lane survives on EVIDENCE OF WORK — a tool call, or a turn that can
      // be placed on the clock — and never on its turn COUNT, which is now read
      // off the rows. A workflow files its seed message and its run-level
      // terminal row under `nodeId: null`, and that terminal row is a
      // `turn_complete` with no duration and no lane of its own: counted, it
      // put an empty lane named `agent` beside the real ones, taking the first
      // colour. A derived span needs a previous row in the lane, which that row
      // does not have, so the two cases stay apart by construction.
      .filter(
        (lane) =>
          lane.toolCalls > 0 ||
          turns.some((turn) => turn.nodeId === lane.nodeId),
      )
  );
}
