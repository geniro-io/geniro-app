import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

@Entity({ tableName: 'ui_surfaces' })
export class UiSurface extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  surfaceId!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'text', nullable: true })
  title: string | null = null;

  @Property({ type: 'text' })
  snapshot!: string;

  @Property({ type: 'text' })
  drafts = '{}';

  @Property({ type: 'text' })
  agentWrites = '[]';

  @Property({ type: 'text' })
  overriddenDrafts = '[]';

  @Property({ type: 'text' })
  oneShotPressed = '[]';

  @Property({ type: 'text' })
  media = '{}';

  @Property({ type: DateTimeType, nullable: true })
  removedAt: Date | null = null;

  @Property({ type: 'string' })
  memberId!: string;

  @Property({ type: 'string', nullable: true })
  conversationId: string | null = null;

  @Property({ type: 'string', nullable: true })
  callId: string | null = null;

  @Property({ type: 'string', nullable: true })
  agentLabel: string | null = null;

  @Property({ type: 'integer' })
  firstSeq!: number;
}
