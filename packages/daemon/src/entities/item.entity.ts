import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';
import type { ItemKind } from '@packages/types';

/** A persisted transcript item belonging to a run. */
@Entity({ tableName: 'items' })
@Index({ properties: ['runId', 'seq'] })
export class Item extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  /** Graph node that produced this item; null for single-agent runs. */
  @Property({ type: 'string', nullable: true })
  nodeId: string | null = null;

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
}
