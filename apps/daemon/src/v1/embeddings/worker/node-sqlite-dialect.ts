import type { DatabaseSync } from 'node:sqlite';

import {
  Kysely,
  type SqliteDatabase,
  SqliteDialect,
  type SqliteStatement,
} from 'kysely';

type SqliteValue = null | number | bigint | string | Uint8Array;

function asSqliteDatabase(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(text: string): SqliteStatement {
      const statement = db.prepare(text);
      const values = (parameters: readonly unknown[]) =>
        parameters as SqliteValue[];
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...values(parameters)),
        run: (parameters) => {
          const result = statement.run(...values(parameters));
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        iterate: (parameters) => statement.iterate(...values(parameters)),
      };
    },
  };
}

/** A typed Kysely builder over a `node:sqlite` connection, for the embedding child's own file. */
export function kyselyOverNodeSqlite<Schema>(db: DatabaseSync): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: new SqliteDialect({ database: asSqliteDatabase(db) }),
  });
}
