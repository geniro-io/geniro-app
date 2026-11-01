import type { Kysely } from 'kysely';

import type { DatabaseMigration } from '../migrations.types';

interface SqliteMasterDatabase {
  sqlite_master: { type: string; name: string };
}

interface IndexRename {
  table: string;
  from: string;
  to: string;
  columns: readonly string[];
  unique: boolean;
}

export const WORKFLOW_TO_TEAM_TABLES: readonly (readonly [string, string])[] = [
  ['workflow_versions', 'team_versions'],
  ['workflow_change_log', 'team_change_log'],
  ['workflow_recommendations', 'team_recommendations'],
];

export const WORKFLOW_TO_TEAM_COLUMNS: readonly (readonly [
  string,
  string,
  string,
])[] = [
  ['runs', 'workflow_id', 'team_id'],
  ['runs', 'pending_workflow_proposal', 'pending_team_proposal'],
  ['runs', 'edits_workflow_slug', 'edits_team_slug'],
  ['runs', 'workflow_instructions', 'team_instructions'],
  ['runs', 'analysis_workflow_slug', 'analysis_team_slug'],
  ['runs', 'workflow_snapshot', 'team_snapshot'],
  ['tasks', 'workflow_slug', 'team_slug'],
  ['projects', 'workflow_slug', 'team_slug'],
  ['run_groups', 'auto_workflow_id', 'auto_team_id'],
  ['usage_activity', 'workflow_slug', 'team_slug'],
  ['usage_activity', 'workflow_version', 'team_version'],
  ['usage_activity', 'workflow_version_inferred', 'team_version_inferred'],
  ['usage_events', 'workflow_name', 'team_name'],
];

/**
 * SQLite keeps an index's name through a table or column rename, and the
 * schema sync keys indexes by the name MikroORM derives from the table and
 * columns, so a stale name would be dropped and rebuilt outside this
 * migration's transaction.
 */
const INDEXES: readonly IndexRename[] = [
  {
    table: 'usage_activity',
    from: 'usage_activity_workflow_slug_kind_index',
    to: 'usage_activity_team_slug_kind_index',
    columns: ['team_slug', 'kind'],
    unique: false,
  },
  {
    table: 'team_change_log',
    from: 'workflow_change_log_slug_changed_at_index',
    to: 'team_change_log_slug_changed_at_index',
    columns: ['slug', 'changed_at'],
    unique: false,
  },
  {
    table: 'team_recommendations',
    from: 'workflow_recommendations_slug_filed_at_index',
    to: 'team_recommendations_slug_filed_at_index',
    columns: ['slug', 'filed_at'],
    unique: false,
  },
  {
    table: 'team_recommendations',
    from: 'workflow_recommendations_chat_run_id_card_seq_item_id_unique',
    to: 'team_recommendations_chat_run_id_card_seq_item_id_unique',
    columns: ['chat_run_id', 'card_seq', 'item_id'],
    unique: true,
  },
];

type Columns = Map<string, Set<string>>;

async function columnsByTable(db: Kysely<unknown>): Promise<Columns> {
  const tables = await db.introspection.getTables();
  return new Map(
    tables.map((table) => [
      table.name,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );
}

async function indexNames(db: Kysely<unknown>): Promise<Set<string>> {
  const rows = await (db as unknown as Kysely<SqliteMasterDatabase>)
    .selectFrom('sqlite_master')
    .select('name')
    .where('type', '=', 'index')
    .execute();
  return new Set(rows.map((row) => row.name));
}

async function renameTables(
  db: Kysely<unknown>,
  pairs: readonly (readonly [string, string])[],
): Promise<void> {
  const columns = await columnsByTable(db);
  for (const [from, to] of pairs) {
    if (columns.has(from) && !columns.has(to)) {
      await db.schema.alterTable(from).renameTo(to).execute();
    }
  }
}

async function renameColumns(
  db: Kysely<unknown>,
  triples: readonly (readonly [string, string, string])[],
): Promise<void> {
  const columns = await columnsByTable(db);
  for (const [table, from, to] of triples) {
    const present = columns.get(table);
    if (present?.has(from) && !present.has(to)) {
      await db.schema.alterTable(table).renameColumn(from, to).execute();
    }
  }
}

async function renameIndexes(
  db: Kysely<unknown>,
  renames: readonly IndexRename[],
): Promise<void> {
  const names = await indexNames(db);
  for (const index of renames) {
    if (!names.has(index.from) || names.has(index.to)) {
      continue;
    }
    await db.schema.dropIndex(index.from).execute();
    const create = db.schema
      .createIndex(index.to)
      .on(index.table)
      .columns([...index.columns]);
    await (index.unique ? create.unique() : create).execute();
  }
}

/** Metadata-only renames of every table, column and index that spelled "workflow"; a fresh profile has none of them and skips each. */
export const workflowToTeamNames: DatabaseMigration = {
  id: '0002-workflow-to-team-names',
  kind: 'database',
  async up({ db }) {
    await renameTables(db, WORKFLOW_TO_TEAM_TABLES);
    await renameColumns(db, WORKFLOW_TO_TEAM_COLUMNS);
    await renameIndexes(db, INDEXES);
  },
  async down({ db }) {
    await renameIndexes(
      db,
      INDEXES.map((index) => ({
        table: index.table,
        from: index.to,
        to: index.from,
        columns: index.columns,
        unique: index.unique,
      })),
    );
    await renameColumns(
      db,
      WORKFLOW_TO_TEAM_COLUMNS.map(([table, from, to]) => [table, to, from]),
    );
    await renameTables(
      db,
      WORKFLOW_TO_TEAM_TABLES.map(([from, to]) => [to, from]),
    );
  },
};
