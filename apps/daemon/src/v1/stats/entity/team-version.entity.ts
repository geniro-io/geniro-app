import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * One graph a team has run with, keyed by the version its runs carry
 * (`teamVersionOf`). Written once, the first time a run of that version is
 * recorded, and never by run teardown: it is what still says what a version
 * WAS once every run of it has been deleted.
 */
@Entity({ tableName: 'team_versions' })
export class TeamVersion extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  slug!: string;

  @PrimaryKey({ type: 'string' })
  version!: string;

  /** The canonical graph (`canonicalGraphJson`) the version is the hash of. */
  @Property({ type: 'text' })
  graph!: string;

  /** The creation time of the earliest run recorded under this version; versions are numbered in this order. */
  @Property({ type: DateTimeType })
  firstSeenAt!: Date;
}
