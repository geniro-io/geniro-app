import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';

/**
 * One finished turn's usage, recorded to OUTLIVE the run that produced it.
 *
 * Every figure here is already in the `turn_complete` item's payload, so this
 * table stores nothing new — what it changes is the LIFETIME. `RunTeardownService`
 * hard-deletes a run's `items` with the soft-delete filter disabled, so a chat
 * the user tidied away takes its whole spend history with it, and a lifetime
 * total computed from `items` silently shrinks every time someone cleans up.
 * Nothing here is written by the teardown, and that omission is the feature.
 *
 * **Dimensions are denormalized on purpose.** `agentKind` / `model` / `cwd` live
 * on `runs` and `node_state`, both of which the same teardown destroys — so a
 * join could only answer for runs that still exist, which is exactly the
 * population this table exists to look past. They are copied at write time and
 * are a record of what that turn actually ran as, not of what the run says now.
 */
@Entity({ tableName: 'usage_events' })
// The idempotency key, and the reason the backfill can run on every boot: a
// turn is identified by its own transcript row, so re-recording one is refused
// by the database rather than by a caller remembering to check.
@Unique({ properties: ['runId', 'seq'] })
// The page's only range predicate — every query here is "this period".
@Index({ properties: ['occurredAt'] })
export class UsageEvent extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /**
   * The run this turn belonged to. Deliberately a plain string with no FK, like
   * `Item.runId` — the row must survive its run's deletion, so a constraint
   * that made it cascade would defeat the table.
   */
  @Property({ type: 'string' })
  runId!: string;

  /** Graph node that produced the turn; null for a single-agent chat. */
  @Property({ type: 'string', nullable: true })
  nodeId: string | null = null;

  /** The source `turn_complete` item's seq — half the idempotency key. */
  @Property({ type: 'integer' })
  seq!: number;

  /**
   * When the turn finished — the source item's own `createdAt`, never this
   * row's. The backfill writes rows long after the fact, so `createdAt` would
   * bucket a year of history into the day the ledger was introduced.
   */
  @Property({ type: 'datetime' })
  occurredAt!: Date;

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /** The folder the turn ran in — the page's per-project breakdown. */
  @Property({ type: 'text', nullable: true })
  cwd: string | null = null;

  /**
   * The workflow this turn belonged to, or null for a single-agent chat.
   *
   * The NAME, denormalized like every dimension here, because the run that
   * knows it is destroyed with the chat and the workflow YAML behind it can be
   * renamed or deleted independently. Rows written before this column existed
   * carry null and are therefore indistinguishable from chats in the breakdown
   * — a name that was never recorded cannot be recovered, and inventing one
   * would be worse than saying nothing.
   */
  @Property({ type: 'text', nullable: true })
  workflowName: string | null = null;

  /**
   * Every figure below is nullable, and null means NOT MEASURED rather than
   * zero. cursor-agent reports no cost unless its currency is USD, and no
   * cache, thinking or timing figures at all, so a column defaulted to 0 would
   * turn "this CLI does not say" into "this cost nothing" — a lie about money
   * that no downstream sum could undo.
   */
  @Property({ type: 'float', nullable: true })
  costUsd: number | null = null;

  @Property({ type: 'integer', nullable: true })
  inputTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  outputTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  cacheReadTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  cacheCreationTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  thinkingTokens: number | null = null;

  /** The CLI's own reported working time for the turn. */
  @Property({ type: 'integer', nullable: true })
  durationMs: number | null = null;

  /** Of that, the part spent inside the model API. */
  @Property({ type: 'integer', nullable: true })
  apiMs: number | null = null;
}
