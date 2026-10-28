/**
 * The full-text index of the shared agent memory: one SQLite FTS5 table over
 * each entry's title and body, kept in step with `memories` by three triggers.
 *
 * The second recorded exception to the typed-builder rule
 * (`.claude/rules/database-queries.md`), for the reason `chat-text-index.ddl.ts`
 * gives: no builder can say `CREATE VIRTUAL TABLE … USING fts5`, and a
 * trigger's body is SQL. Every statement is a constant, and every QUERY against
 * the table goes through the typed builder.
 *
 * Rows are keyed by `memories.rowid`, with `memory_id` beside it for the join.
 * A table rebuild by the schema sync drops the triggers, which
 * `MemoryTextIndexService.ensure` detects at boot and answers by rebuilding the
 * index from `memories`.
 *
 * CHANGING ANY STATEMENT HERE means bumping {@link MEMORY_TEXT_VERSION}, for
 * the reasons the chat index's doc block gives: every statement is
 * `IF NOT EXISTS`, and a new version's missing triggers are what make the next
 * boot rebuild.
 */

export const MEMORY_TEXT_VERSION = 1;

/**
 * The FTS table and its shadow tables, for the schema sync to leave out of
 * its introspection (see `CHAT_TEXT_TABLES`). Never matches `memories` itself.
 */
export const MEMORY_TEXT_TABLES = /^memories_fts(_|$)/;

export const CREATE_MEMORY_TEXT_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')`;

export const DROP_MEMORY_TEXT_TABLE = 'DROP TABLE IF EXISTS memories_fts';

/** APPEND-ONLY, like the chat index's: earlier versions' drops derive from it. */
const TRIGGER_EVENTS = ['insert', 'update', 'delete'] as const;
type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

const triggerName = (version: number, event: TriggerEvent): string =>
  `memories_fts_v${version}_after_${event}`;

const TRIGGER_BODIES: Record<TriggerEvent, (name: string) => string> = {
  insert: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER INSERT ON memories BEGIN INSERT OR REPLACE INTO memories_fts (rowid, memory_id, title, body) VALUES (new.rowid, new.id, new.title, new.body); END`,
  update: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER UPDATE OF title, body ON memories BEGIN DELETE FROM memories_fts WHERE rowid = old.rowid; INSERT OR REPLACE INTO memories_fts (rowid, memory_id, title, body) VALUES (new.rowid, new.id, new.title, new.body); END`,
  delete: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE rowid = old.rowid; END`,
};

export const MEMORY_TEXT_TRIGGERS: readonly { name: string; sql: string }[] =
  TRIGGER_EVENTS.map((event) => {
    const name = triggerName(MEMORY_TEXT_VERSION, event);
    return { name, sql: TRIGGER_BODIES[event](name) };
  });

/** `DROP TRIGGER` for every trigger a version before `version` created. */
export function retiredMemoryTriggerDrops(version: number): string[] {
  return Array.from({ length: version - 1 }, (_, index) => index + 1).flatMap(
    (old) =>
      TRIGGER_EVENTS.map(
        (event) => `DROP TRIGGER IF EXISTS ${triggerName(old, event)}`,
      ),
  );
}

export const DROP_RETIRED_MEMORY_TEXT_TRIGGERS: readonly string[] =
  retiredMemoryTriggerDrops(MEMORY_TEXT_VERSION);
