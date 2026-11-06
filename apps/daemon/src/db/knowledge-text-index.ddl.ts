/**
 * The full-text index of the knowledge store: one SQLite FTS5 table over each
 * document's title, when-to-read line and body, kept in step with
 * `knowledge_documents` by three triggers.
 *
 * The third recorded exception to the typed-builder rule
 * (`.claude/rules/database-queries.md`), for the reason
 * `chat-text-index.ddl.ts` gives. Every statement is a constant, and every
 * QUERY against the table goes through the typed builder.
 *
 * Rows are keyed by `knowledge_documents.rowid`, with `document_id` beside it
 * for the join. {@link KNOWLEDGE_TEXT_RANK} is an INSERT stored in
 * `knowledge_fts_config`, so a drop and recreate loses it:
 * `KnowledgeTextIndexService.ensure` runs it at every boot.
 *
 * CHANGING ANY STATEMENT HERE means bumping {@link KNOWLEDGE_TEXT_VERSION}, for
 * the reasons the chat index's doc block gives.
 *
 * Keep {@link KNOWLEDGE_TEXT_TABLES} in `skipTables` for as long as a profile
 * may hold this table, a revert included: an FTS5 column has no declared type,
 * so a schema sync that sees it throws at every boot.
 */

export const KNOWLEDGE_TEXT_VERSION = 1;

/** The FTS table and its shadow tables, for the schema sync to leave out. */
export const KNOWLEDGE_TEXT_TABLES = /^knowledge_fts(_|$)/;

export const CREATE_KNOWLEDGE_TEXT_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(document_id UNINDEXED, title, when_to_read, body, tokenize = 'unicode61 remove_diacritics 2')`;

export const DROP_KNOWLEDGE_TEXT_TABLE = 'DROP TABLE IF EXISTS knowledge_fts';

/** Weights are positional and count the UNINDEXED column. */
export const KNOWLEDGE_TEXT_RANK = `INSERT INTO knowledge_fts(knowledge_fts, rank) VALUES('rank', 'bm25(0, 8.0, 4.0, 1.0)')`;

/** APPEND-ONLY, like the chat index's: earlier versions' drops derive from it. */
const TRIGGER_EVENTS = ['insert', 'update', 'delete'] as const;
type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

const triggerName = (version: number, event: TriggerEvent): string =>
  `knowledge_fts_v${version}_after_${event}`;

const INSERT_ROW = `INSERT OR REPLACE INTO knowledge_fts (rowid, document_id, title, when_to_read, body) VALUES (new.rowid, new.id, new.title, new.when_to_read, new.body)`;

const TRIGGER_BODIES: Record<TriggerEvent, (name: string) => string> = {
  insert: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER INSERT ON knowledge_documents BEGIN ${INSERT_ROW}; END`,
  update: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER UPDATE OF title, when_to_read, body ON knowledge_documents BEGIN DELETE FROM knowledge_fts WHERE rowid = old.rowid; ${INSERT_ROW}; END`,
  delete: (name) =>
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON knowledge_documents BEGIN DELETE FROM knowledge_fts WHERE rowid = old.rowid; END`,
};

export const KNOWLEDGE_TEXT_TRIGGERS: readonly { name: string; sql: string }[] =
  TRIGGER_EVENTS.map((event) => {
    const name = triggerName(KNOWLEDGE_TEXT_VERSION, event);
    return { name, sql: TRIGGER_BODIES[event](name) };
  });

/** `DROP TRIGGER` for every trigger a version before `version` created. */
export function retiredKnowledgeTriggerDrops(version: number): string[] {
  return Array.from({ length: version - 1 }, (_, index) => index + 1).flatMap(
    (old) =>
      TRIGGER_EVENTS.map(
        (event) => `DROP TRIGGER IF EXISTS ${triggerName(old, event)}`,
      ),
  );
}

export const DROP_RETIRED_KNOWLEDGE_TEXT_TRIGGERS: readonly string[] =
  retiredKnowledgeTriggerDrops(KNOWLEDGE_TEXT_VERSION);
