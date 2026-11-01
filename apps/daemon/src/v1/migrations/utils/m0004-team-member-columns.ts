import type { DatabaseMigration } from '../migrations.types';
import { type ColumnRename, renameColumns } from './rename-columns';

export const NODE_TO_MEMBER_COLUMNS: readonly ColumnRename[] = [
  ['node_state', 'node_id', 'member_id'],
  ['items', 'node_id', 'member_id'],
  ['call_context', 'node_id', 'member_id'],
  ['wall_turns', 'node_id', 'member_id'],
  ['usage_events', 'node_id', 'member_id'],
];

/** Metadata-only column renames; the one index naming `items.node_id` keeps its name (see `Item`), so nothing is rebuilt. */
export const teamMemberColumns: DatabaseMigration = {
  id: '0004-team-member-columns',
  kind: 'database',
  async up({ db }) {
    await renameColumns(db, NODE_TO_MEMBER_COLUMNS);
  },
  async down({ db }) {
    await renameColumns(
      db,
      NODE_TO_MEMBER_COLUMNS.map(([table, from, to]) => [table, to, from]),
    );
  },
};
