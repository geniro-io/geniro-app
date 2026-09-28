import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind, NodeStatus } from '../runs.types';

/** Per-node execution status within a run (composite PK: runId + nodeId). */
@Entity({ tableName: 'node_state' })
export class NodeState extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  nodeId!: string;

  @Property({ type: 'string' })
  status: NodeStatus = 'pending';

  /** Underlying CLI session id, for resume/inspection (populated in M2). */
  @Property({ type: 'string', nullable: true })
  agentSessionId: string | null = null;

  /**
   * The CLI that actually ran this node's turn, stamped at turn start. Run
   * history must not depend on the live workflow YAML: editing a node's agent
   * after runs exist would otherwise make the terminal mirror resume a past
   * session with the wrong CLI. Null on pre-existing rows (legacy fallback:
   * the YAML lookup).
   */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /**
   * The model that turn actually ran as, stamped beside the agent kind and for
   * the same reason: run history must not depend on the live workflow YAML.
   *
   * Without it the terminal mirror of a workflow node had nothing to open on
   * and fell back to the CLI's own default — a different model with a
   * different context window sitting beside the transcript it mirrors. Reading
   * the CURRENT definition instead is exactly the drift `agentKind` is stamped
   * to prevent. Null on a pre-existing row, and null for a node that names no
   * model (the CLI's default is then the honest answer).
   */
  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /**
   * The last context reading this node reported, and the window it was scaled
   * against — the per-node twin of `Run.contextTokens`.
   *
   * A CHAT has had a durable reading since the live plane proved too thin to
   * draw a ring from: that plane is ephemeral, so a client that reloads,
   * reconnects, or opens the run for the first time has nothing, and a node
   * PARKED in `await_agent` emits nothing for minutes on end. A workflow node
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

  @Property({ type: 'integer', nullable: true })
  contextWindowTokens: number | null = null;

  /**
   * How long this node's agent has WORKED and how many tool calls it has made,
   * both totalled across every turn the node has taken.
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
   * How far each of this node's cursor CONVERSATIONS has been priced — JSON,
   * the conversation id (the ACP session id, which Cursor calls
   * `conversationId`) → the newest usage event already folded into the run's
   * recorded spend, as epoch millis. The watermarks that make
   * `Run.cursorCostCents` an ACCUMULATOR rather than a snapshot of one window.
   *
   * Per CONVERSATION and not per node, because one node routinely holds
   * several: every call to it is a conversation of its own, and a compaction
   * replaces one. It was a single number beside {@link agentSessionId}, which
   * every turn overwrites — so only the node's LAST conversation was ever
   * priced, and one shared mark put a late-billed event of the older
   * conversation behind the newer one's and dropped it for good.
   *
   * Null, or a conversation missing from it, means never priced: the next poll
   * re-baselines the run's total once, then accumulates from there.
   */
  @Property({ type: 'text', nullable: true })
  cursorSpendThrough: string | null = null;

  /**
   * EVERY CLI session this node has run in, oldest first — JSON, an array of
   * session ids, written beside {@link agentSessionId} by `saveSessionId`.
   *
   * `agentSessionId` is the one to RESUME, and every turn overwrites it: each
   * call to the node is a conversation of its own, and a compaction replaces
   * one. What a session COST outlives that — Cursor bills a conversation's
   * requests after the fact — so the usage poll prices every session here, not
   * only the latest. Written by the turn path alone, so it never races the
   * poll's own column above.
   */
  @Property({ type: 'text', nullable: true })
  sessionIds: string | null = null;

  /**
   * This node's share of `Run.cursorCostCents` — the polled price of the
   * conversation on this row. The run's figure is the whole run; a workflow
   * holds claude and cursor nodes side by side, so without a per-node figure
   * the cursor node's card had no cost and the run's header had no way to add
   * the cursor bill to the claude turns rather than replace them. Null means
   * never priced on this row, which is also how a row priced before this
   * column existed reads (`nodeCursorSpend` falls back to the run's figure
   * where that is unambiguous).
   */
  @Property({ type: 'float', nullable: true })
  cursorCostCents: number | null = null;

  /** How many billable events {@link cursorCostCents} was summed from. */
  @Property({ type: 'integer', nullable: true })
  cursorCostEvents: number | null = null;

  @Property({ type: 'integer', nullable: true })
  startedAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endedAt: number | null = null;

  @Property({ type: 'text', nullable: true })
  error: string | null = null;

  /**
   * The last context and plan reading this node's agent gave, as JSON — the
   * per-node twin of `Run.lastMetricsReading`, and for the same reason.
   *
   * A workflow node's process is closed for idleness like a chat's, and a
   * Manager waiting on its callees is idle for exactly the stretch in which
   * someone opens its readout. Asked only of the live process, that readout
   * was empty while a claude chat beside it showed its breakdown and its plan
   * limits from the reading it had kept — REPORTED against a workflow whose
   * Manager is claude. On the node rather than the run, because a workflow run
   * holds one window per node.
   */
  @Property({ type: 'text', nullable: true })
  lastMetricsReading: string | null = null;
}
