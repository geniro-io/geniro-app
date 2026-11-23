import { z } from 'zod';

export const EMBEDDING_DIM = 768;
export const EMBEDDING_MAX_TOKENS = 1024;
export const EMBEDDING_CHAT_CHUNK_TOKENS = 512;
export const EMBEDDING_BATCH_SIZE = 8;
export const EMBEDDING_QUERY_TIMEOUT_MS = 2_000;
export const EMBEDDING_BATCH_TIMEOUT_MS = 60_000;
export const EMBEDDING_CONTROL_TIMEOUT_MS = 30_000;
export const EMBEDDING_IDLE_UNLOAD_MS = 5 * 60_000;
export const EMBEDDING_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
export const EMBEDDING_GIVE_UP_MS = 10 * 60_000;
/** How many meaning matches a memory or knowledge search fuses with its word matches. */
export const EMBEDDING_MEANING_CANDIDATES = 50;
/**
 * A meaning match below this cosine is not a match: unrelated text still scores
 * 0.45–0.62 with this model, related text 0.7 and up.
 */
export const EMBEDDING_MIN_SIMILARITY = 0.65;
/**
 * The chat floor, stricter than {@link EMBEDDING_MIN_SIMILARITY}: a history
 * holds thousands of messages, and at 0.65 a third of unrelated queries still
 * reached long messages. Real paraphrases measured 0.709–0.958.
 */
export const EMBEDDING_CHAT_MIN_SIMILARITY = 0.7;
/**
 * Shorter chat messages are not searched by meaning ("OK", "Done.", "давай"):
 * they scored 0.67–0.75 against nearly any query. Word search still finds them.
 */
export const EMBEDDING_CHAT_MIN_CHARS = 32;
export const EMBEDDING_CHAT_KNN_MAX = 500;
export const EMBEDDING_CHAT_KNN_PER_HIT = 10;
/** Chat items embedded per indexing step, so a step never holds the child for long. */
export const EMBEDDING_CHAT_STEP_ITEMS = 32;
export const EMBEDDING_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** How often new chat messages are looked for; the child starts only when there are some. */
export const EMBEDDING_CHAT_POLL_MS = 10 * 60_000;
export const EMBEDDING_CHANGED_THROTTLE_MS = 1_000;
/** Deleted rows, as a share of all chat chunks, past which the child compacts the file. */
export const EMBEDDING_VACUUM_SHARE = 0.1;

export const EMBEDDING_SOURCES = ['memory', 'knowledge', 'chats'] as const;
export type EmbeddingSource = (typeof EMBEDDING_SOURCES)[number];
export type DocumentSource = Exclude<EmbeddingSource, 'chats'>;

export const EmbeddingModelRefSchema = z
  .object({
    id: z.string().min(1).max(100),
    revision: z.string().min(7).max(64),
    dir: z.string().min(1).max(4096),
    dim: z.number().int().positive(),
  })
  .meta({ id: 'EmbeddingModelRef' });
export type EmbeddingModelRef = z.infer<typeof EmbeddingModelRefSchema>;

/**
 * What Electron main pushes: whether search by meaning is on, the model it
 * downloaded and verified, a newer one being indexed beside it, and whether the
 * Mac runs on battery (chat indexing waits for power).
 *
 * TWIN PARSER: `searchConfigOf` in `apps/ui/src/main/search-config-push.ts`.
 */
export const EmbeddingConfigSchema = z
  .object({
    enabled: z.boolean(),
    model: EmbeddingModelRefSchema.nullable(),
    pendingModel: EmbeddingModelRefSchema.nullable(),
    onBattery: z.boolean(),
  })
  .meta({ id: 'EmbeddingConfig' });
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  model: null,
  pendingModel: null,
  onBattery: false,
};

export const EMBEDDING_STATES = [
  'off',
  'loading',
  'indexing',
  'ready',
  'failed',
] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

const EmbeddingCountSchema = z.object({
  indexed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const EmbeddingStatusSchema = z.object({
  state: z.enum(EMBEDDING_STATES),
  model: z.object({ id: z.string(), revision: z.string() }).nullable(),
  pendingModel: z
    .object({ id: z.string(), revision: z.string(), complete: z.boolean() })
    .nullable(),
  counts: z.object({
    memory: EmbeddingCountSchema,
    knowledge: EmbeddingCountSchema,
    chats: EmbeddingCountSchema.extend({
      paused: z.enum(['battery']).nullable(),
    }),
  }),
  indexBytes: z.number().int().nonnegative(),
  failure: z.string().nullable(),
});
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

/**
 * Broadcast as `embeddings_changed` whenever the status may have moved; every
 * client re-reads `GET /v1/embeddings/status`.
 *
 * TWIN PARSER: `parseEmbeddingsChanged` in `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface EmbeddingsChangedEvent {
  reason: 'config' | 'progress' | 'state' | 'cleared';
}

/** One text to embed: its whole-text hash decides whether stored vectors are current. */
export interface EmbedDocument {
  sourceId: string;
  textHash: string;
  chunks: string[];
}

export interface EmbedChatItem {
  itemId: string;
  runId: string;
  createdAt: number;
  textHash: string;
  text: string;
}

export interface SourceScore {
  sourceId: string;
  similarity: number;
}

export interface ChatScore {
  itemId: string;
  runId: string;
  similarity: number;
}

export type ModelSlot = 'active' | 'pending';

/** A module whose rows are embedded: memory or knowledge. Registered at its module init. */
export interface DocumentSourceProvider {
  readonly source: DocumentSource;
  /** Every live document's id and current text hash, for the backfill and the totals. */
  inventory(): Promise<{ sourceId: string; textHash: string }[]>;
  /** The current text of these ids; an id missing from the answer has no text any more. */
  documents(sourceIds: readonly string[]): Promise<EmbedDocument[]>;
}

/** A chat message the index reads, with the `items` rowid its cursors walk. */
export interface ChatSourceRow extends EmbedChatItem {
  rowid: number;
}

/** Chat history, as the agents module reads it for the index. */
export interface ChatSourceProvider {
  total(): Promise<number>;
  newestRowid(): Promise<number>;
  /** Up to `limit` rows below `rowid`, newest first. */
  before(rowid: number, limit: number): Promise<ChatSourceRow[]>;
  /** Up to `limit` rows above `rowid`, oldest first. */
  after(rowid: number, limit: number): Promise<ChatSourceRow[]>;
  liveRunIds(): Promise<string[]>;
}

export interface EmbeddingCounts {
  memory: number;
  knowledge: number;
  chats: number;
}

/** Requests the daemon sends the embedding child, each answered once by id. */
export type WorkerRequest =
  | { op: 'open'; dbPath: string }
  | {
      op: 'models';
      active: EmbeddingModelRef | null;
      pending: EmbeddingModelRef | null;
    }
  | { op: 'unload' }
  | {
      op: 'missing';
      source: DocumentSource;
      slot: ModelSlot;
      items: { sourceId: string; textHash: string }[];
    }
  | {
      op: 'index';
      source: DocumentSource;
      slot: ModelSlot;
      documents: EmbedDocument[];
    }
  | { op: 'indexChats'; slot: ModelSlot; items: EmbedChatItem[] }
  | {
      op: 'score';
      source: DocumentSource;
      query: string;
      sourceIds: string[] | null;
      limit: number;
    }
  | { op: 'searchChats'; query: string; k: number; runIds: string[] | null }
  | { op: 'delete'; source: DocumentSource; sourceIds: string[] }
  | { op: 'deleteRuns'; runIds: string[] }
  | { op: 'keepRuns'; runIds: string[] }
  | { op: 'counts'; slot: ModelSlot }
  | { op: 'getMeta'; key: string }
  | { op: 'setMeta'; key: string; value: string | null }
  | { op: 'promote' }
  | { op: 'clear' };

export interface WorkerResults {
  open: { indexBytes: number };
  models: null;
  unload: null;
  missing: string[];
  index: { stored: number };
  indexChats: { stored: number };
  score: SourceScore[];
  searchChats: ChatScore[];
  delete: { deleted: number };
  deleteRuns: { deleted: number };
  keepRuns: { deleted: number };
  counts: EmbeddingCounts & { indexBytes: number };
  getMeta: string | null;
  setMeta: null;
  promote: null;
  clear: null;
}

export type WorkerOp = WorkerRequest['op'];
export type WorkerRequestOf<Op extends WorkerOp> = Extract<
  WorkerRequest,
  { op: Op }
>;

/** The child's envelope on the IPC channel: an answer to one request id. */
export type WorkerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** A deletion queued by the daemon while the child was down, drained on its next start. */
export interface QueuedDeletion {
  source: EmbeddingSource;
  sourceId: string | null;
  runId: string | null;
  queuedAt: number;
}

/** `embeddings.db`, as the child's Kysely reads it. */
export interface EmbeddingsDatabase {
  meta: { key: string; value: string };
  vectors: {
    source: string;
    source_id: string;
    chunk: number;
    text_hash: string;
    model: string;
    vec: Uint8Array;
  };
  chat_chunks: {
    id: number | null;
    run_id: string;
    item_id: string;
    chunk: number;
    text_hash: string;
    created_at: number;
    model: string;
  };
  chat_vec: { rowid: number; model: string; embedding: Uint8Array };
  deletions: {
    source: string;
    source_id: string | null;
    run_id: string | null;
    queued_at: number;
  };
}
