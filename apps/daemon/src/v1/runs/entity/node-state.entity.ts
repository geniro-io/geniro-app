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
   * The newest cursor usage event already folded into this run's recorded
   * spend, as epoch millis — the watermark that makes `Run.cursorCostCents` an
   * ACCUMULATOR rather than a snapshot of one window.
   *
   * Per NODE rather than per run because it is really per CONVERSATION, and
   * {@link agentSessionId} — which is the id Cursor calls `conversationId` — is
   * on this row. A run holding several conversations would otherwise share one
   * watermark, and a late-billed event on the older conversation would fall
   * behind the newer one's mark and never be counted.
   *
   * Null means this conversation has never been priced, which is also how a row
   * written before the watermark existed reads: the next poll re-baselines it
   * by replacing the run's total once, then accumulates from here on.
   */
  @Property({ type: 'integer', nullable: true })
  cursorSpendThroughMs: number | null = null;

  @Property({ type: 'integer', nullable: true })
  startedAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endedAt: number | null = null;

  @Property({ type: 'text', nullable: true })
  error: string | null = null;
}
