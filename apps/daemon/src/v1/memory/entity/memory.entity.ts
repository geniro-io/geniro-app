import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import type {
  MemoryActorKind,
  MemoryStatus,
  MemoryType,
} from '../memory.types';

/**
 * One entry of the memory every agent shares, whichever CLI it runs on.
 *
 * `projectId` null means GLOBAL (every project's runs see it). Provenance is a
 * plain copy, never a foreign key: a deleted chat leaves its memories behind,
 * and run teardown never touches this table.
 */
@Entity({ tableName: 'memories' })
@Index({ properties: ['projectId', 'status'] })
@Unique({ properties: ['handle'] })
export class Memory extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** Shown as `m<handle>`; allocated one past the highest, never reused. */
  @Property({ type: 'integer' })
  handle!: number;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  body!: string;

  @Property({ type: 'string' })
  type!: MemoryType;

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'string' })
  status!: MemoryStatus;

  /** Bumped by every write; a writer quoting an older one is refused. */
  @Property({ type: 'integer' })
  rev: number = 1;

  @Property({ type: 'string' })
  sourceActor!: MemoryActorKind;

  @Property({ type: 'string', nullable: true })
  sourceAgentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  sourceModel: string | null = null;

  @Property({ type: 'string', nullable: true })
  sourceRunId: string | null = null;

  @Property({ type: 'text', nullable: true })
  sourceImportedFrom: string | null = null;

  @Property({ type: 'text', nullable: true })
  forgetReason: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  lastUsedAt: Date | null = null;
}
