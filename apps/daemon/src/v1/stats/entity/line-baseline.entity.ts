import { randomUUID } from 'node:crypto';

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * The commit a repository's lines are measured against, per branch.
 *
 * Every thread in one repository and branch measures the whole repository's diff, whichever
 * subfolder it works in, so measuring each against its own start commit counts work two
 * threads share once per thread. One baseline per repository and branch makes the totals one
 * series, whichever thread's turn took the measurement. It is set by the first thread measured
 * there (its start commit), and replaced only when the repository can no longer be measured
 * from it.
 *
 * Kept beside the ledger rather than on any run, and like the ledger it is never torn
 * down with a run: the thread that set it can be deleted while the repository goes on.
 */
@Entity({ tableName: 'line_baselines' })
@Unique({ properties: ['folderKey'] })
export class LineBaseline extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** The repository and branch, hashed (`folderKeyOf`). */
  @Property({ type: 'string' })
  folderKey!: string;

  /** The repository root the baseline was set for, or the thread's folder when no root was honoured. */
  @Property({ type: 'text' })
  root!: string;

  /** Null on a detached HEAD. */
  @Property({ type: 'string', nullable: true })
  branch: string | null = null;

  @Property({ type: 'string' })
  baseSha!: string;
}
