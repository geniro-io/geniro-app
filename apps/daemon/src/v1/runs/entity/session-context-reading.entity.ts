import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * What one member's CLI said its fresh session held, asked once when the
 * session opened. Runtime data of its run, purged with it.
 */
@Entity({ tableName: 'session_context_readings' })
export class SessionContextReading extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  sessionId!: string;

  @Property({ type: 'string' })
  memberId!: string;

  @Property({ type: 'integer', nullable: true })
  poolMember: number | null = null;

  @Property({ type: 'string' })
  agent!: string;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: 'text' })
  breakdown!: string;
}
