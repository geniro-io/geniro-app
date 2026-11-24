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

import type {
  ReviewAgentStatus,
  ReviewCommentSide,
  ReviewCommentStatus,
} from '../../agents/chat.types';

/**
 * One comment the user left on a thread's changes in the review screen. Stored
 * in geniro only, never in git; purged with its run by `RunTeardownService`.
 */
@Entity({ tableName: 'review_comments' })
@Unique({ properties: ['runId', 'number'] })
@Index({ properties: ['runId', 'status'] })
export class ReviewComment extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  @Property({ type: 'integer' })
  number!: number;

  @Property({ type: 'text' })
  folder!: string;

  @Property({ type: 'text' })
  path!: string;

  @Property({ type: 'string' })
  side!: ReviewCommentSide;

  @Property({ type: 'integer', nullable: true })
  startLine: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endLine: number | null = null;

  @Property({ type: 'text' })
  quote!: string;

  @Property({ type: 'text' })
  body!: string;

  @Property({ type: 'string' })
  status!: ReviewCommentStatus;

  @Property({ type: 'integer', nullable: true })
  sentSeq: number | null = null;

  @Property({ type: DateTimeType, nullable: true })
  sentAt: Date | null = null;

  @Property({ type: 'string', nullable: true })
  agentStatus: ReviewAgentStatus | null = null;

  @Property({ type: 'text', nullable: true })
  agentReply: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  agentRepliedAt: Date | null = null;

  @Property({ type: 'string', nullable: true })
  agentMemberId: string | null = null;
}
