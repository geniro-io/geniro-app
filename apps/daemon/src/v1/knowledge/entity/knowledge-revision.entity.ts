import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import type {
  KnowledgeActorKind,
  KnowledgeRevisionStatus,
} from '../knowledge.types';

/** The whole text of one version of a document, applied or waiting on review. */
@Entity({ tableName: 'knowledge_revisions' })
@Index({ properties: ['documentId', 'status'] })
export class KnowledgeRevision extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  documentId!: string;

  /** Set when applied, null while pending or rejected. */
  @Property({ type: 'integer', nullable: true })
  rev: number | null = null;

  @Property({ type: 'string' })
  status!: KnowledgeRevisionStatus;

  /** The document's rev this was made against. */
  @Property({ type: 'integer' })
  baseRev!: number;

  @Property({ type: 'string' })
  handle!: string;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  whenToRead!: string;

  @Property({ type: 'text' })
  body!: string;

  @Property({ type: 'integer' })
  bodyBytes!: number;

  @Property({ type: 'string' })
  sourceActor!: KnowledgeActorKind;

  @Property({ type: 'string', nullable: true })
  sourceRunId: string | null = null;

  @Property({ type: 'string', nullable: true })
  sourceMemberId: string | null = null;

  @Property({ type: 'string', nullable: true })
  sourceAgentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  sourceModel: string | null = null;

  /** When the user took this text as theirs; a restore keeps it unreviewed otherwise. */
  @Property({ type: DateTimeType, nullable: true })
  approvedAt: Date | null = null;

  @Property({ type: 'text', nullable: true })
  reason: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  decidedAt: Date | null = null;
}
