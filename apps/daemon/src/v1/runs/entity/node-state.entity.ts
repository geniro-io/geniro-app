import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind, NodeStatus } from '../runs.types';

/** Per-member execution status within a run (composite PK: runId + memberId). */
@Entity({ tableName: 'node_state' })
export class NodeState extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  memberId!: string;

  @Property({ type: 'string' })
  status: NodeStatus = 'pending';

  /** Underlying CLI session id, for resume/inspection. */
  @Property({ type: 'string', nullable: true })
  agentSessionId: string | null = null;

  /**
   * The CLI that actually ran this member's turn, stamped at turn start. Run
   * history must not depend on the live team YAML: editing a member's agent
   * after runs exist would otherwise make the terminal mirror resume a past
   * session with the wrong CLI. Null until the member's first turn starts
   * (readers then fall back to the YAML lookup).
   */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /**
   * The model that turn actually ran as, stamped beside the agent kind and for
   * the same reason: run history must not depend on the live team YAML.
   *
   * Without it the terminal mirror of a team member had nothing to open on
   * and fell back to the CLI's own default — a different model with a
   * different context window sitting beside the transcript it mirrors. Reading
   * the CURRENT definition instead is exactly the drift `agentKind` is stamped
   * to prevent. Null on a pre-existing row, and null for a member that names no
   * model (the CLI's default is then the honest answer).
   */
  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /**
   * The last context reading this member reported, and the window it was scaled
   * against — the per-member twin of `Run.contextTokens`.
   *
   * A CHAT has had a durable reading since the live plane proved too thin to
   * draw a ring from: that plane is ephemeral, so a client that reloads,
   * reconnects, or opens the run for the first time has nothing, and a member
   * PARKED in `await_agent` emits nothing for minutes on end. A team member
   * had no such column at all, so its ring simply went blank — reported as
   * "here i dont see manager context" over a caller blocked on its callee while
   * the callee's own ring, still streaming, sat directly beneath it.
   *
   * Written from every `context_progress` and again from the `turn_complete`
   * that carries the window, and — like the run's — never CLEARED by a reading
   * that omits one: silence says nothing about a figure.
   */
  @Property({ type: 'integer', nullable: true })
  contextTokens: number | null = null;

  /**
   * Whether {@link contextTokens} is geniro's stand-in rather than an
   * occupancy the CLI stated (`AgentUsage.contextEstimated`). Written with
   * every count and cleared with it; null reads as stated.
   */
  @Property({ type: 'boolean', nullable: true })
  contextEstimated: boolean | null = null;

  @Property({ type: 'integer', nullable: true })
  contextWindowTokens: number | null = null;

  /**
   * How long this member's agent has WORKED and how many tool calls it has made,
   * both totalled across every turn the member has taken.
   *
   * They are durable for the reason the pair above is — `HISTORY_PAGE` bounds
   * the transcript a client loads, so any figure folded from loaded items
   * describes the loaded part rather than the thread — but they ACCUMULATE
   * where that pair is replaced. A context reading is a level: the newest one
   * is the whole truth and an older one is worthless. These are totals, so the
   * newest reading is a fraction of the answer, which is why the writer sums
   * (`NodeStateDao.rememberWork`) rather than following `rememberContext`.
   *
   * Null means never measured, never zero: an agent that has taken no turn
   * shows no figure rather than `0s · 0 tools`, which claims a measurement
   * nobody took. A CLI that reports no timing leaves `workedMs` null while
   * still counting its tools, so the two are independently nullable.
   */
  @Property({ type: 'integer', nullable: true })
  workedMs: number | null = null;

  @Property({ type: 'integer', nullable: true })
  toolCalls: number | null = null;

  /**
   * What each of this member's polled CONVERSATIONS has cost, as the account
   * last reported it — JSON, conversation id (for cursor, the ACP session id,
   * a callee conversation or a delegate's own conversation) → a
   * `ConversationSpend` (`utils/polled-spend-ledger.ts`): a settled sum plus
   * every still-revisable event under its own key.
   *
   * Per EVENT rather than a watermark, because a vendor revises a charge after
   * listing it. The watermark it replaced counted each event the first time it
   * was seen and never again, which froze a long agent request at whatever it
   * had cost when first listed — measured on a real account, a member recorded
   * $8.44 for ten events that summed to $134.86. {@link polledCostCents} is
   * this ledger's sum, rewritten whole on every poll.
   *
   * Null, or a conversation missing from it, means never priced: the next poll
   * prices it from the member's start.
   */
  @Property({ type: 'text', nullable: true })
  polledSpend: string | null = null;

  /**
   * EVERY CLI session this member has run in, oldest first — JSON, an array of
   * session ids, written beside {@link agentSessionId} by `saveSessionId`.
   *
   * `agentSessionId` is the one to RESUME, and every turn overwrites it: each
   * call to the member is a conversation of its own, and a compaction replaces
   * one. What a session COST outlives that — a polled account bills a
   * conversation's requests after the fact — so the usage poll prices every
   * session here, not only the latest. Written by the turn path alone, so it
   * never races the poll's own column above.
   */
  @Property({ type: 'text', nullable: true })
  sessionIds: string | null = null;

  /**
   * This member's share of `Run.polledCostCents` — the polled price of the
   * conversation on this row. A team mixes CLIs, so without a per-member
   * figure a polled member's card had no cost and the run's header could not add
   * the polled bill to the self-priced turns rather than replace them. Null
   * means never priced on this row.
   */
  @Property({ type: 'float', nullable: true })
  polledCostCents: number | null = null;

  /** How many billable events {@link polledCostCents} was summed from. */
  @Property({ type: 'integer', nullable: true })
  polledCostEvents: number | null = null;

  @Property({ type: 'integer', nullable: true })
  startedAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endedAt: number | null = null;

  @Property({ type: 'text', nullable: true })
  error: string | null = null;

  /**
   * The last context and plan reading this member's agent gave, as JSON — the
   * per-member twin of `Run.lastMetricsReading`, and for the same reason.
   *
   * A team member's process is closed for idleness like a chat's, and a
   * Manager waiting on its callees is idle for exactly the stretch in which
   * someone opens its readout. Asked only of the live process, that readout
   * was empty while a claude chat beside it showed its breakdown and its plan
   * limits from the reading it had kept — REPORTED against a team whose
   * Manager is claude. On the member rather than the run, because a team run
   * holds one window per node.
   */
  @Property({ type: 'text', nullable: true })
  lastMetricsReading: string | null = null;
}
