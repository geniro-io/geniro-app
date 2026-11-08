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
import type { KnowledgeActorKind, KnowledgeStatus } from '../knowledge.types';

/**
 * One knowledge document, filed in a project, a team or Global.
 *
 * `placeKey` carries the uniqueness because SQLite treats NULLs as distinct.
 * Provenance is a plain copy, never a foreign key, and run teardown never
 * touches this table. Archive is `status`, never `deletedAt`: a permanent
 * delete is hard, so the FTS trigger fires and the handle is freed.
 */
@Entity({ tableName: 'knowledge_documents' })
@Index({ properties: ['projectId', 'status'] })
@Index({ properties: ['teamSlug', 'status'] })
@Unique({ properties: ['placeKey', 'handle'] })
export class KnowledgeDocument extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  handle!: string;

  @Property({ type: 'string' })
  placeKey!: string;

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  whenToRead!: string;

  @Property({ type: 'text' })
  body!: string;

  /** So that a listing never reads `body`. */
  @Property({ type: 'integer' })
  bodyBytes!: number;

  @Property({ type: 'string' })
  status!: KnowledgeStatus;

  /** 0 while proposed, then 1 upward; a writer quoting an older one is refused. */
  @Property({ type: 'integer' })
  rev: number = 0;

  /** Set by the user's write or approval; an unreviewed agent write clears it. */
  @Property({ type: DateTimeType, nullable: true })
  approvedAt: Date | null = null;

  @Property({ type: 'string' })
  sourceActor!: KnowledgeActorKind;

  @Property({ type: 'string', nullable: true })
  sourceRunId: string | null = null;

  @Property({ type: 'string', nullable: true })
  sourceAgentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  sourceModel: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  lastReadAt: Date | null = null;
}
