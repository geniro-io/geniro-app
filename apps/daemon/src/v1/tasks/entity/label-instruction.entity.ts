import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * Instructions attached to one task LABEL, composed into every task that
 * carries it — see `utils/label-instructions-prompt.ts`.
 *
 * `projectId` null means GLOBAL: the instruction applies to every project's
 * tasks. A project id scopes it to that board alone. This is the opposite
 * direction from `Task.folder`'s own null-means-inherit reading — there null
 * defers to a narrower default; here null is the WIDER scope, and a project
 * row is the override layered on top of it for that board.
 */
@Entity({ tableName: 'label_instructions' })
// The composer's own query: every label a task's project (or no project at
// all) could carry an instruction for.
@Index({ properties: ['label'] })
export class LabelInstruction extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'text' })
  label!: string;

  @Property({ type: 'text' })
  instructions!: string;
}
