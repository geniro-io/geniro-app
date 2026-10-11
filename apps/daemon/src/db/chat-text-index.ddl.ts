/**
 * The full-text index of every chat's messages and reasoning: one SQLite FTS5
 * table, kept in step with `items` by three triggers.
 *
 * The recorded exception to the typed-builder rule
 * (`.claude/rules/database-queries.md` names this file). Neither MikroORM's
 * schema generator nor Kysely's schema builder can say `CREATE VIRTUAL TABLE …
 * USING fts5`, and a trigger's body is SQL by definition. Every statement is a
 * constant: nothing here is built from a runtime value, and every QUERY against
 * the table goes through the typed builder.
 *
 * Triggers rather than writes from TypeScript, because `items` is written by
 * more than one path (the persist seam, ORM flushes, run teardown's purge) and
 * a path that forgot the index would leave it silently stale. Inside the
 * database the index moves in the same transaction as the row, so a message is
 * searchable the moment it is stored.
 *
 * Rows are keyed by `items.rowid` so a delete is a rowid lookup; `item_id`
 * rides beside it so a read joins on the item's real id. A table rebuild by the
 * schema sync drops its triggers (and may renumber rowids), which is exactly
 * what `ChatTextIndexService.ensure` checks for at boot: any trigger missing
 * means the index is rebuilt from `items`.
 *
 * CHANGING ANY STATEMENT HERE means bumping {@link CHAT_TEXT_VERSION}: every
 * statement is `IF NOT EXISTS`, so an install that already has the index would
 * otherwise keep the old definition for good. A new version's triggers are
 * missing on the next boot, which rebuilds the table and the triggers and
 * drops every earlier version's. The inserts are `OR REPLACE` so that two
 * versions' triggers left installed together — an older build started on a
 * newer profile — rewrite one row instead of failing every message write on
 * the duplicate rowid.
 *
 * `CASE WHEN json_valid(…)` guards every JSON read: a malformed payload must
 * never fail the item write the trigger runs inside.
 */

export const CHAT_TEXT_VERSION = 1;

/**
 * The FTS table and the shadow tables FTS5 keeps beside it (`chat_text_data`,
 * `_idx`, `_content`, `_docsize`, `_config`), for the schema sync to leave
 * out of its introspection: it reads every table's columns, an FTS5 column
 * has no declared type, and MikroORM's type mapping throws on one — so every
 * boot after the index exists would fail inside `orm.schema.update`.
 */
export const CHAT_TEXT_TABLES = /^chat_text(_|$)/;

/** What the index holds: the rows a person or an agent wrote in words. */
export const CHAT_TEXT_KINDS = ['message', 'reasoning'] as const;

export const CREATE_CHAT_TEXT_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS chat_text USING fts5(item_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')`;

export const DROP_CHAT_TEXT_TABLE = 'DROP TABLE IF EXISTS chat_text';

const INDEXED_ROW = `new.kind IN (${CHAT_TEXT_KINDS.map((kind) => `'${kind}'`).join(', ')}) AND (CASE WHEN json_valid(new.payload) THEN json_type(new.payload, '$.text') END) = 'text'`;

/**
 * Every trigger the index keeps, by the event it fires on. APPEND-ONLY: the
 * drops for earlier versions are derived from this list, so an event removed
 * from it would leave its old trigger installed for good.
 */
const TRIGGER_EVENTS = ['insert', 'update', 'delete'] as const;
type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

const triggerName = (version: number, event: TriggerEvent): string =>
  `chat_text_v${version}_after_${event}`;

const TRIGGER_BODIES: Record<TriggerEvent, (name: string) => string> = {
  insert: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER INSERT ON items WHEN ${INDEXED_ROW} BEGIN INSERT OR REPLACE INTO chat_text (rowid, item_id, text) VALUES (new.rowid, new.id, json_extract(new.payload, '$.text')); END`,
  update: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER UPDATE OF kind, payload ON items BEGIN DELETE FROM chat_text WHERE rowid = old.rowid; INSERT OR REPLACE INTO chat_text (rowid, item_id, text) SELECT new.rowid, new.id, json_extract(new.payload, '$.text') WHERE ${INDEXED_ROW}; END`,
  delete: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON items BEGIN DELETE FROM chat_text WHERE rowid = old.rowid; END`,
};

export const CHAT_TEXT_TRIGGERS: readonly { name: string; sql: string }[] =
  TRIGGER_EVENTS.map((event) => {
    const name = triggerName(CHAT_TEXT_VERSION, event);
    return { name, sql: TRIGGER_BODIES[event](name) };
  });

/** `DROP TRIGGER` for every trigger a version before `version` created. */
export function retiredTriggerDrops(version: number): string[] {
  return Array.from({ length: version - 1 }, (_, index) => index + 1).flatMap(
    (old) =>
      TRIGGER_EVENTS.map(
        (event) => `DROP TRIGGER IF EXISTS ${triggerName(old, event)}`,
      ),
  );
}

export const DROP_RETIRED_CHAT_TEXT_TRIGGERS: readonly string[] =
  retiredTriggerDrops(CHAT_TEXT_VERSION);
