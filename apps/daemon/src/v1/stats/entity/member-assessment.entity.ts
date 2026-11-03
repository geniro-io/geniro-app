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

import type { MemberVerdict } from '../../agents/chat.types';
import type { MemberAssessmentChat } from '../stats.types';

/**
 * One member of a library team as an analysis judged it — its usefulness and
 * quality marks, its verdict and the card items that carry the verdict out —
 * copied from the card a team analysis, a builder chat or a thread analysis of
 * one of the team's runs filed. The chat goes with a new analysis or its
 * source; this copy is how the team page and the next analysis see how each
 * member's marks moved. Never written by run teardown.
 */
@Entity({ tableName: 'member_assessments' })
@Unique({ properties: ['chatRunId', 'cardSeq', 'memberId'] })
@Index({ properties: ['slug', 'filedAt'] })
export class MemberAssessmentRecord extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  slug!: string;

  /** The chat that filed the card; a plain copy, never a foreign key. */
  @Property({ type: 'string' })
  chatRunId!: string;

  @Property({ type: 'string' })
  chatKind!: MemberAssessmentChat;

  @Property({ type: 'integer' })
  cardSeq!: number;

  /** The card row's own time. */
  @Property({ type: DateTimeType })
  filedAt!: Date;

  /** The library's team version when the card was filed; null when it was not read then. */
  @Property({ type: 'string', nullable: true })
  libraryVersion: string | null = null;

  /** How many runs the analysis read: one for a thread analysis. */
  @Property({ type: 'integer' })
  runs!: number;

  /** The runs the analysis read, as JSON — whose versions the marks describe. */
  @Property({ type: 'text', nullable: true })
  runIds: string | null = null;

  @Property({ type: 'string' })
  memberId!: string;

  /** Null when the runs gave too little to judge. */
  @Property({ type: 'integer', nullable: true })
  usefulness: number | null = null;

  @Property({ type: 'integer', nullable: true })
  quality: number | null = null;

  @Property({ type: 'string' })
  verdict!: MemberVerdict;

  @Property({ type: 'text' })
  summary!: string;

  /** The cited rows, as JSON. */
  @Property({ type: 'text' })
  evidence!: string;

  /** The card items that carry the verdict out, `[{id, title}]` as JSON. */
  @Property({ type: 'text' })
  items!: string;
}
