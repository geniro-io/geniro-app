import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { ShareActor, ShareStatus } from '../shares.types';

/**
 * One artifact the user (or an agent) shared through an encrypted link.
 *
 * Deliberately outside run teardown: deleting or archiving the chat leaves the
 * link working, so this row — the only way to revoke it later — must outlive
 * the run. `runId` is therefore a plain string, never a foreign key.
 *
 * The decryption key is NOT here: it lives in the Keychain under this row's id
 * (`ShareKeychain`, `services/share-keychain.service.ts`), and the link carries it in its fragment.
 */
@Entity({ tableName: 'artifact_shares' })
// One share per page: sharing it again re-uploads to the same object, so the
// link the user already handed out keeps working and shows the newer version.
@Unique({ properties: ['runId', 'artifactId'] })
export class ArtifactShare extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  @Property({ type: 'string' })
  artifactId!: string;

  @Property({ type: 'text' })
  title!: string;

  /**
   * The destination as it was when first shared (JSON of `ShareDestination`),
   * so a later revoke deletes from where the object actually is even after the
   * user edited or removed that destination in Settings.
   */
  @Property({ type: 'text' })
  destination!: string;

  /** Random path segment the object is stored under. */
  @Property({ type: 'string' })
  objectId!: string;

  @Property({ type: 'text' })
  linkBase!: string;

  /**
   * The version the object holds; 0 while nothing was ever uploaded (a share
   * waiting on the user's sign-in, or one that then failed). Kept NOT NULL on
   * purpose: changing a column's nullability makes the boot schema sync
   * rebuild the table, and this one is the only record of every live link.
   */
  @Property({ type: 'integer' })
  sharedVersion!: number;

  @Property({ type: 'string' })
  sharedBy!: ShareActor;

  @Property({ type: 'string' })
  status: ShareStatus = 'live';

  /** Why the last upload or revoke failed, shown beside the row. */
  @Property({ type: 'text', nullable: true })
  lastError: string | null = null;

  /**
   * The agent conversations that asked for this share while it could not be
   * uploaded (a JSON array of `ShareAsker`), each woken with the outcome once
   * the user signs in. Null for a share nobody is waiting on.
   */
  @Property({ type: 'text', nullable: true })
  asker: string | null = null;

  /**
   * When every asker had been woken with the outcome (each leaves `asker` as
   * its wake settles); null while one is still owed.
   */
  @Property({ type: DateTimeType, nullable: true })
  agentToldAt: Date | null = null;
}
