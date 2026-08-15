import { randomUUID } from 'node:crypto';

import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { RunGroupColor } from '../../agents/chat.types';

/**
 * A user-made folder in the chat sidebar — a name, a colour and an order, that
 * runs are filed under via {@link Run.groupId}.
 *
 * Runtime state, not a definition: a group is how one machine's user chose to
 * arrange their own sidebar, so it lives in SQLite beside the runs it holds
 * rather than in a YAML file (which is reserved for workflows — the things the
 * user authors, exports and shares). Deleting one RELEASES its runs instead of
 * taking them with it; nothing here owns a conversation.
 */
@Entity({ tableName: 'run_groups' })
export class RunGroup extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'text' })
  name!: string;

  /**
   * Which of the palette's hues this group wears, as a NAME rather than a
   * colour value: the renderer forbids a hardcoded colour anywhere in its
   * source, so a hex travelling on the wire would arrive somewhere it could
   * not legally be used. The name maps to a design token at the one place that
   * knows about tokens.
   */
  @Property({ type: 'string' })
  color: RunGroupColor = 'blue';

  /**
   * Where the group sits in the sidebar, ascending. Kept CONTIGUOUS from 0 by
   * every write that reorders (see `RunGroupsService.move`), so "the one above
   * this" is always `position - 1` and no gap can accumulate into an ordering
   * two clients disagree about.
   */
  @Property({ type: 'integer' })
  position = 0;

  /** Whether the sidebar draws it folded shut. */
  @Property({ type: 'boolean' })
  collapsed = false;

  /**
   * A project folder whose new chats land in this group automatically, or null
   * for a group the user fills by hand.
   *
   * Canonical (the path `resolveValidDirectory` returned when it was set), so
   * it can be compared against a run's own canonical `cwd` without either side
   * re-resolving. A run STARTED under it or under any folder inside it
   * matches; see `RunGroupsService.resolveAutoGroupId` for why the most
   * specific claim wins.
   */
  @Property({ type: 'text', nullable: true })
  autoCwd: string | null = null;
}
