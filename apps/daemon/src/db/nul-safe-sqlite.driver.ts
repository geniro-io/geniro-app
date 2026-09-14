import type { Configuration, Constructor } from '@mikro-orm/core';
import {
  AbstractSqlDriver,
  MikroORM,
  SqliteConnection,
  SqlitePlatform,
} from '@mikro-orm/sqlite';

/**
 * The SQLite platform, with the one character its escaping cannot carry.
 *
 * MikroORM 7 binds nothing. Every statement is rendered with its values PASTED
 * IN (`AbstractSqlConnection.prepareQuery` → `Platform.formatQuery`) and run as
 * raw SQL, so a value is only as safe as its escaping. Quotes are doubled
 * correctly; a NUL byte is not handled at all, and SQLite's tokenizer ends a
 * string literal at a NUL whatever length the statement is handed. The literal
 * is left unterminated and the whole statement fails with `unrecognized token`.
 *
 * MEASURED against better-sqlite3 in Electron's own runtime: the same insert
 * succeeds plain, succeeds with a quote, succeeds with a NUL when the value is
 * BOUND, and fails `unrecognized token: "'still running"` with the NUL pasted in
 * — the exact line the daemon had been logging. Transcript text carries NULs
 * whenever an agent prints binary output or writes a control character
 * literally, and `Item.searchText` keeps them raw (the payload beside it is JSON,
 * which escapes them). Measured on the reporter's own logs: ~350 failed writes in
 * one conversation on 2026-09-13 and a run in another on 2026-09-14, each lost
 * row turning into `run event persistence failed` when its turn ended.
 *
 * `char(0)` is how SQLite spells the byte, so such a string is rendered as a
 * concatenation — `('a' || char(0) || 'b')` — which stores the value byte for
 * byte rather than dropping the character, and is a valid expression anywhere a
 * value is pasted (a VALUES list, a comparison, an IN list).
 */
export class NulSafeSqlitePlatform extends SqlitePlatform {
  override escape(value: unknown): string {
    if (typeof value !== 'string' || !value.includes('\u0000')) {
      return super.escape(value);
    }
    const parts = value.split('\u0000').map((part) => super.escape(part));
    return `(${parts.join(' || char(0) || ')})`;
  }
}

/**
 * `@mikro-orm/sqlite`'s own `SqliteDriver`, with {@link NulSafeSqlitePlatform}
 * in place of the stock platform — the stock driver's constructor is the same
 * call with `new SqlitePlatform()`, so nothing else about the wiring differs.
 */
export class NulSafeSqliteDriver extends AbstractSqlDriver<SqliteConnection> {
  constructor(config: Configuration) {
    super(config, new NulSafeSqlitePlatform(), SqliteConnection, [
      'kysely',
      'better-sqlite3',
    ]);
  }

  override getORMClass(): Constructor<MikroORM> {
    return MikroORM;
  }
}
