import type { Kysely } from 'kysely';

export type ColumnRename = readonly [table: string, from: string, to: string];

export async function columnsByTable(
  db: Kysely<unknown>,
): Promise<Map<string, Set<string>>> {
  const tables = await db.introspection.getTables();
  return new Map(
    tables.map((table) => [
      table.name,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );
}

/** Renames each column whose table has it and lacks the new name, so a step re-run or a fresh profile does nothing. */
export async function renameColumns(
  db: Kysely<unknown>,
  renames: readonly ColumnRename[],
): Promise<void> {
  const columns = await columnsByTable(db);
  for (const [table, from, to] of renames) {
    const present = columns.get(table);
    if (present?.has(from) && !present.has(to)) {
      await db.schema.alterTable(table).renameColumn(from, to).execute();
    }
  }
}
