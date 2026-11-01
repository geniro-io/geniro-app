import { randomUUID } from 'node:crypto';

import {
  BeforeCreate,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import { payloadRefsOf } from '../../agents/utils/payload-refs';
import type { ItemKind } from '../runs.types';

/** A persisted transcript item belonging to a run. */
@Entity({ tableName: 'items' })
@Index({ properties: ['runId', 'seq'] })
// Every OTHER query here is scoped by run and rides the index above. The usage
// ledger's boot backfill is the one that is not: it asks for `turn_complete`
// rows across every run, once per launch, before the daemon reports ready.
// Without this index that is a full scan of a table whose rows are message and
// tool-result payloads — so launch time would grow with the user's entire
// transcript history rather than with how many turns they have finished.
@Index({ properties: ['kind'] })
// A page's anchors, and the run-wide readouts, ask one run for the handful of
// rows of a few kinds (its calls, its delegate declarations), often only on
// one side of a page. On `(runId, seq)` that is a walk over the whole run; on
// `kind` alone it is a walk over every run's rows of that kind.
@Index({ properties: ['runId', 'kind', 'seq'] })
// A team run is paged one conversation at a time (`inCall`), and a page of
// its own flow asks each call it shows for the few rows of a few kinds its card
// is drawn from.
@Index({ properties: ['runId', 'inCall', 'seq'] })
@Index({ properties: ['runId', 'inCall', 'kind', 'seq'] })
// The payload fields run-wide lookups filter on. Each column sits after
// `payload` in the row, so reading it off the table walks the payload's
// overflow pages: only a covering index makes the lookup cheap.
@Index({ properties: ['runId', 'kind', 'payloadId'] })
@Index({ properties: ['runId', 'kind', 'toolNameLower'] })
// Named as it was before `node_id` became `member_id`: SQLite keeps an index's
// name through a column rename, and a derived name would rebuild it on every
// profile's largest table.
@Index({
  name: 'items_run_id_kind_parent_tool_use_id_node_id_in_call_seq_deleted_at_index',
  properties: [
    'runId',
    'kind',
    'parentToolUseId',
    'memberId',
    'inCall',
    'seq',
    'deletedAt',
  ],
})
@Index({ properties: ['runId', 'kind', 'callId'] })
export class Item extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  /** Team member that produced this item; null for single-agent runs. */
  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  /** Monotonic ordering within the run. */
  @Property({ type: 'integer' })
  seq!: number;

  @Property({ type: 'string' })
  kind!: ItemKind;

  @Property({ type: 'string', nullable: true })
  role: string | null = null;

  /** JSON-encoded payload (shape depends on `kind`). */
  @Property({ type: 'text' })
  payload!: string;

  /**
   * The payload's text flattened for search — see `utils/searchable-text.ts`.
   *
   * NULL means "never flattened". A row that WAS flattened and had nothing to
   * match carries an empty string instead, so the two stay distinguishable.
   *
   * Deliberately NOT indexed. The search is a `$like` with a leading wildcard,
   * which no B-tree can serve, so an index here would cost every insert and be
   * used by nothing — the query rides the `(runId, seq)` index above for its
   * range and ordering, with the match as a residual filter.
   */
  @Property({ type: 'text', nullable: true })
  searchText: string | null = null;

  /**
   * The call whose card this row is drawn in, or `OUTSIDE_ANY_CALL` (`''`) for
   * the run's own flow — `utils/call-membership.ts`. NULL means no build has
   * stamped the row yet: the column was added to a table that already held
   * every row, and `ItemCallIndexService.ensureIndexed` fills those per run
   * before a conversation read trusts it.
   */
  @Property({ type: 'string', nullable: true })
  inCall: string | null = null;

  /**
   * `payload.id`, `payload.name` (lowercased), `payload.parentToolUseId` and
   * `payload.callId`, copied when the row is written (`utils/payload-refs.ts`).
   * A row written before the columns existed holds NULL in all four until the
   * boot sweep stamps its run; `Run.payloadRefsVersion` says whether a run's
   * columns can be trusted.
   */
  @Property({ type: 'string', nullable: true })
  payloadId: string | null = null;

  @Property({ type: 'string', nullable: true })
  toolNameLower: string | null = null;

  @Property({ type: 'string', nullable: true })
  parentToolUseId: string | null = null;

  @Property({ type: 'string', nullable: true })
  callId: string | null = null;

  @BeforeCreate()
  stampPayloadRefs(): void {
    Object.assign(this, payloadRefsOf(this.payload));
  }
}
