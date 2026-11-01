import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * One turn the daemon measured by the WALL clock, because its CLI did not time
 * it (every ACP agent) — composite PK: runId + the `seq` of the `turn_complete`
 * that ended the turn.
 *
 * One row per measured turn rather than a running total, so recording is
 * idempotent by construction: a catch-up inserts every turn it measures and a
 * turn already recorded is ignored by the key (`WallTurnDao.record`). Nothing
 * depends on the order turns become durable in, and no write is a
 * read-modify-write. Rows are never updated.
 *
 * What a reader is served as an agent's worked time is the CLI-reported total
 * (`NodeState.workedMs` / `Run.workedMs`, CLI-only) plus the sum of these rows
 * — the node's for a team node, the `nodeId: null` ones for a 1:1 chat.
 * Run-scoped: dropped with the run by `RunTeardownService`, unlike the usage
 * ledgers that outlive teardown.
 */
@Entity({ tableName: 'wall_turns' })
export class WallTurn extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  /** The seq of the `turn_complete` row that ended the measured turn. */
  @PrimaryKey({ type: 'integer' })
  seq!: number;

  /** The team node that took the turn, or null for a 1:1 chat's agent. */
  @Property({ type: 'string', nullable: true })
  nodeId: string | null = null;

  /** How long the turn worked, parked approval stretches excluded. Always > 0. */
  @Property({ type: 'integer' })
  ms!: number;
}
