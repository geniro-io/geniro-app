import { existsSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { firstValueFrom, type Observable, Subject } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';

import {
  type ChatScore,
  type ChatSourceProvider,
  DEFAULT_EMBEDDING_CONFIG,
  type DocumentSource,
  type DocumentSourceProvider,
  EMBEDDING_BATCH_TIMEOUT_MS,
  EMBEDDING_CHANGED_THROTTLE_MS,
  EMBEDDING_CHAT_POLL_MS,
  EMBEDDING_CHAT_STEP_ITEMS,
  EMBEDDING_CONTROL_TIMEOUT_MS,
  EMBEDDING_DAY_MS,
  EMBEDDING_QUERY_TIMEOUT_MS,
  EMBEDDING_SOURCES,
  EMBEDDING_SWEEP_INTERVAL_MS,
  EMBEDDING_TOTALS_FRESH_MS,
  type EmbeddingConfig,
  type EmbeddingCounts,
  type EmbeddingModelRef,
  type EmbeddingsChangedEvent,
  type EmbeddingsDatabase,
  type EmbeddingSource,
  type EmbeddingStatus,
  type ModelSlot,
  type SourceScore,
} from '../embeddings.types';
import { kyselyOverNodeSqlite } from '../worker/node-sqlite-dialect';
import { EmbeddingProcessService } from './embedding-process.service';

const DOCUMENT_BATCH = 16;
const DOCUMENT_SOURCES: readonly DocumentSource[] = ['memory', 'knowledge'];
const SLOTS: readonly ModelSlot[] = ['active', 'pending'];
const RESUME_MARGIN_MS = 100;
const SOURCE_WORDS: Record<EmbeddingSource, string> = {
  memory: 'memory',
  knowledge: 'knowledge documents',
  chats: 'chats',
};

/** Where the forward cursors step back to once the newest rowid is `newest`: a step's worth below it. */
function rewoundFloor(newest: number): number {
  return Math.max(0, newest - EMBEDDING_CHAT_STEP_ITEMS);
}

function keyOf(model: Pick<EmbeddingModelRef, 'id' | 'revision'>): string {
  return `${model.id}@${model.revision}`;
}

interface SlotProgress {
  key: string;
  backfilled: Set<DocumentSource>;
  chatsDone: boolean;
  forward: number | null;
  back: number | null;
  counts: EmbeddingCounts;
  countsRead: boolean;
}

function emptyProgress(
  key: string,
  counts: EmbeddingCounts = { memory: 0, knowledge: 0, chats: 0 },
): SlotProgress {
  return {
    key,
    backfilled: new Set(),
    chatsDone: false,
    forward: null,
    back: null,
    counts,
    countsRead: false,
  };
}

function forwardCursorKey(model: EmbeddingModelRef): string {
  return `chats:${keyOf(model)}:fwd`;
}

const CHAT_WINDOW_KEY = 'chat_window_days';
const ALL_TIME = 'all';

function windowValue(days: number | null): string {
  return days === null ? ALL_TIME : String(days);
}

/** Whether chats `days` back reach further than the window the index was last trimmed to. */
function widens(days: number | null, stored: string): boolean {
  return stored !== ALL_TIME && (days === null || days > Number(stored));
}

function scopeChanged(before: EmbeddingConfig, next: EmbeddingConfig): boolean {
  return (
    before.chatWindowDays !== next.chatWindowDays ||
    EMBEDDING_SOURCES.some(
      (source) => before.sources[source] !== next.sources[source],
    )
  );
}

function withinWindow<T extends { createdAt: number }>(
  rows: readonly T[],
  cutoff: number | null,
): T[] {
  return cutoff === null
    ? [...rows]
    : rows.filter((row) => row.createdAt >= cutoff);
}

/**
 * What search by meaning knows and does: the config Electron main pushed, the
 * queue of texts to embed (memory before knowledge before chats), the chat
 * cursors, and the queries the three searches ask. Every query answers null
 * when meaning search cannot answer in time, so its caller keeps its word
 * search.
 */
@Injectable()
export class EmbeddingIndexService implements OnApplicationShutdown {
  private readonly logger = new Logger(EmbeddingIndexService.name);
  private readonly changed = new Subject<EmbeddingsChangedEvent>();
  private config: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
  private readonly documentProviders = new Map<
    DocumentSource,
    DocumentSourceProvider
  >();
  private chatProvider: ChatSourceProvider | null = null;
  private readonly jobs = new Map<DocumentSource, Set<string>>(
    DOCUMENT_SOURCES.map((source) => [source, new Set<string>()]),
  );
  private progress: Record<ModelSlot, SlotProgress | null> = {
    active: null,
    pending: null,
  };
  private totals: EmbeddingCounts = { memory: 0, knowledge: 0, chats: 0 };
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private chatPoll: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private lastChanged = 0;
  private totalsReadAt = 0;
  private totalsReading: Promise<void> | null = null;
  private changedTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private purgeDue = false;

  constructor(private readonly process: EmbeddingProcessService) {
    this.process.changes().subscribe((event) => {
      if (event.kind === 'crashed') {
        this.emit('state');
        this.resumeAfter(event.restartInMs);
      }
    });
  }

  registerDocuments(provider: DocumentSourceProvider): void {
    this.documentProviders.set(provider.source, provider);
    this.kick();
  }

  registerChats(provider: ChatSourceProvider): void {
    this.chatProvider = provider;
    this.kick();
  }

  changes(): Observable<EmbeddingsChangedEvent> {
    return this.changed.asObservable();
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.model !== null;
  }

  async setConfig(next: EmbeddingConfig): Promise<EmbeddingConfig> {
    const before = this.config;
    this.config = { ...next };
    this.process.forgiveFailures();
    const wasEnabled = before.enabled && before.model !== null;
    if (!this.enabled) {
      this.stopTimers();
      this.process.stop();
      this.emit('config');
      return this.config;
    }
    const promoted =
      before.pendingModel !== null &&
      next.model !== null &&
      next.pendingModel === null &&
      keyOf(before.pendingModel) === keyOf(next.model);
    if (!wasEnabled) {
      this.progress = {
        active: this.restarted(this.progress.active),
        pending: this.restarted(this.progress.pending),
      };
    }
    this.progress = {
      active: this.carried(next.model),
      pending: next.pendingModel ? this.carried(next.pendingModel) : null,
    };
    if (!wasEnabled || scopeChanged(before, next)) {
      this.applySources();
    }
    await this.process
      .setModels(next.model, next.pendingModel)
      .catch((err: unknown) =>
        this.logger.warn(
          `could not hand the embedding child its models: ${String(err)}`,
        ),
      );
    if (promoted) {
      await this.process
        .request({ op: 'promote' }, EMBEDDING_CONTROL_TIMEOUT_MS)
        .catch((err: unknown) =>
          this.logger.warn(
            `could not drop the replaced model's vectors: ${String(err)}`,
          ),
        );
    }
    this.startTimers();
    this.emit('config');
    this.kick();
    return this.config;
  }

  /** A chat message was stored. While chats wait for power nothing indexes it, so readers are told the total may have moved. */
  chatAdded(): void {
    if (this.enabled && this.config.onBattery && this.config.sources.chats) {
      this.emit('progress');
    }
  }

  enqueue(source: DocumentSource, sourceIds: readonly string[]): void {
    if (
      !this.enabled ||
      !this.config.sources[source] ||
      sourceIds.length === 0
    ) {
      return;
    }
    const queue = this.jobs.get(source);
    for (const id of sourceIds) {
      queue?.add(id);
    }
    this.kick();
  }

  async deleteDocuments(
    source: DocumentSource,
    sourceIds: readonly string[],
  ): Promise<void> {
    if (sourceIds.length === 0) {
      return;
    }
    for (const id of sourceIds) {
      this.jobs.get(source)?.delete(id);
    }
    await this.deleteOrQueue(
      () =>
        this.process.request(
          { op: 'delete', source, sourceIds: [...sourceIds] },
          EMBEDDING_CONTROL_TIMEOUT_MS,
        ),
      sourceIds.map((sourceId) => ({
        source,
        source_id: sourceId,
        run_id: null,
      })),
    );
  }

  async deleteRuns(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) {
      return;
    }
    await this.rewindChatCursors();
    await this.deleteOrQueue(
      () =>
        this.process.request(
          { op: 'deleteRuns', runIds: [...runIds] },
          EMBEDDING_CONTROL_TIMEOUT_MS,
        ),
      runIds.map((runId) => ({
        source: 'chats',
        source_id: null,
        run_id: runId,
      })),
    );
  }

  /**
   * The meaning matches of `query` among `sourceIds` (all when null), best
   * first, or null when meaning search cannot answer: off, no model, a
   * crashed or busy child, or no answer within the query budget.
   */
  async scoreDocuments(
    source: DocumentSource,
    query: string,
    sourceIds: readonly string[] | null,
    limit: number,
  ): Promise<SourceScore[] | null> {
    if (
      !this.enabled ||
      !this.config.sources[source] ||
      (sourceIds !== null && sourceIds.length === 0)
    ) {
      return null;
    }
    try {
      return await this.process.request(
        {
          op: 'score',
          source,
          query,
          sourceIds: sourceIds === null ? null : [...sourceIds],
          limit,
        },
        EMBEDDING_QUERY_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.debug(
        `meaning search for ${source} fell back to words: ${String(err)}`,
      );
      return null;
    }
  }

  /** The nearest chat messages to `query`, restricted to `runIds` when given; null as above. */
  async searchChats(
    query: string,
    k: number,
    runIds: readonly string[] | null,
  ): Promise<ChatScore[] | null> {
    if (
      !this.enabled ||
      !this.config.sources.chats ||
      (runIds !== null && runIds.length === 0)
    ) {
      return null;
    }
    try {
      return await this.process.request(
        {
          op: 'searchChats',
          query,
          k,
          runIds: runIds === null ? null : [...runIds],
        },
        EMBEDDING_QUERY_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.debug(
        `meaning search for chats fell back to words: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * The one sentence a search of `source` adds while search by meaning is on
   * but leaves part of that source to word search; null when nothing is left
   * out or search by meaning is off altogether.
   */
  meaningNote(source: EmbeddingSource): string | null {
    if (!this.enabled) {
      return null;
    }
    if (!this.config.sources[source]) {
      return `Search by meaning is off for ${SOURCE_WORDS[source]} in Settings → Search, so only word matches are listed.`;
    }
    const days = this.config.chatWindowDays;
    if (source === 'chats' && days !== null) {
      return `Search by meaning covers only chats from the last ${days} ${days === 1 ? 'day' : 'days'}; older messages are found by their words alone.`;
    }
    return null;
  }

  async status(): Promise<EmbeddingStatus> {
    if (this.enabled) {
      await this.refreshTotals().catch(() => undefined);
    }
    const active = this.progress.active;
    const pending = this.progress.pending;
    const counts = active?.counts ?? { memory: 0, knowledge: 0, chats: 0 };
    const chatsLeft = counts.chats < this.totals.chats;
    const failure = this.process.failure;
    const busy = this.running !== null || this.backlog() > 0;
    return {
      state: !this.enabled
        ? 'off'
        : failure
          ? 'failed'
          : busy || !this.slotComplete('active')
            ? 'indexing'
            : 'ready',
      model: this.config.model
        ? { id: this.config.model.id, revision: this.config.model.revision }
        : null,
      pendingModel: this.config.pendingModel
        ? {
            id: this.config.pendingModel.id,
            revision: this.config.pendingModel.revision,
            complete: pending !== null && this.slotComplete('pending'),
          }
        : null,
      counts: {
        memory: {
          indexed: Math.min(counts.memory, this.totals.memory),
          total: this.totals.memory,
        },
        knowledge: {
          indexed: Math.min(counts.knowledge, this.totals.knowledge),
          total: this.totals.knowledge,
        },
        chats: {
          indexed: Math.min(counts.chats, this.totals.chats),
          total: this.totals.chats,
          paused:
            this.config.onBattery &&
            chatsLeft &&
            this.enabled &&
            this.config.sources.chats
              ? 'battery'
              : null,
        },
      },
      indexBytes: this.indexBytes(),
      failure,
    };
  }

  /** Delete the whole index; with search by meaning on, it is built again. */
  async clear(): Promise<void> {
    if (this.process.alive) {
      const stopped = firstValueFrom(
        this.process.changes().pipe(
          filter((event) => event.kind !== 'started'),
          timeout(5_000),
        ),
      ).catch(() => undefined);
      this.process.stop();
      await stopped;
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(this.process.dbPath + suffix, { force: true });
    }
    this.progress = {
      active: this.config.model
        ? emptyProgress(keyOf(this.config.model))
        : null,
      pending: this.config.pendingModel
        ? emptyProgress(keyOf(this.config.pendingModel))
        : null,
    };
    this.emit('cleared');
    this.kick();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.stopTimers();
  }

  private carried(model: EmbeddingModelRef | null): SlotProgress | null {
    if (!model) {
      return null;
    }
    const key = keyOf(model);
    for (const slot of SLOTS) {
      const seen = this.progress[slot];
      if (seen?.key === key) {
        return seen;
      }
    }
    return emptyProgress(key);
  }

  /** Switched on again: every check runs anew, but the counts it last read stay on screen meanwhile. */
  private restarted(progress: SlotProgress | null): SlotProgress | null {
    return progress === null
      ? null
      : emptyProgress(progress.key, progress.counts);
  }

  /** A crash can cut a batch short; once the child may start again, the work left over carries on. */
  private resumeAfter(delayMs: number): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.kick();
    }, delayMs + RESUME_MARGIN_MS);
    this.resumeTimer.unref();
  }

  private kick(): void {
    if (this.stopped || !this.enabled) {
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.work()
      .catch((err: unknown) =>
        this.logger.warn(`embedding index work stopped: ${String(err)}`),
      )
      .finally(() => {
        this.running = null;
        this.emit('progress');
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  private async work(): Promise<void> {
    for (const slot of SLOTS) {
      const progress = this.progress[slot];
      if (progress && !progress.countsRead) {
        await this.refreshCounts(slot, progress);
        this.emit('progress');
      }
    }
    if (this.purgeDue) {
      this.purgeDue = false;
      await this.purgeExcluded().catch((err: unknown) => {
        this.purgeDue = true;
        throw err;
      });
    }
    while (!this.stopped && this.enabled) {
      let moved = false;
      for (const slot of SLOTS) {
        const progress = this.progress[slot];
        if (!progress) {
          continue;
        }
        moved = (await this.documentStep(slot, progress)) || moved;
        if (moved) {
          break;
        }
        if (!this.config.onBattery && this.config.sources.chats) {
          moved = await this.chatStep(slot, progress);
          if (moved) {
            break;
          }
        }
      }
      if (!moved) {
        return;
      }
      this.emit('progress');
    }
  }

  private async documentStep(
    slot: ModelSlot,
    progress: SlotProgress,
  ): Promise<boolean> {
    for (const source of DOCUMENT_SOURCES) {
      const provider = this.documentProviders.get(source);
      if (!provider || !this.config.sources[source]) {
        continue;
      }
      if (!progress.backfilled.has(source)) {
        const inventory = await provider.inventory();
        this.totals[source] = inventory.length;
        const missing = await this.process.request(
          { op: 'missing', source, slot, items: inventory },
          EMBEDDING_BATCH_TIMEOUT_MS,
        );
        progress.backfilled.add(source);
        if (missing.length > 0) {
          this.enqueueFor(source, missing);
        }
        await this.refreshCounts(slot, progress);
        return true;
      }
      const queue = this.jobs.get(source);
      if (!queue || queue.size === 0) {
        continue;
      }
      const ids = [...queue].slice(0, DOCUMENT_BATCH);
      for (const id of ids) {
        queue.delete(id);
      }
      try {
        const documents = await provider.documents(ids);
        const found = new Set(documents.map((document) => document.sourceId));
        const gone = ids.filter((id) => !found.has(id));
        for (const target of SLOTS) {
          if (!this.progress[target]) {
            continue;
          }
          if (documents.length === 0) {
            continue;
          }
          const stale = new Set(
            await this.process.request(
              {
                op: 'missing',
                source,
                slot: target,
                items: documents.map(({ sourceId, textHash }) => ({
                  sourceId,
                  textHash,
                })),
              },
              EMBEDDING_CONTROL_TIMEOUT_MS,
            ),
          );
          const changed = documents.filter((document) =>
            stale.has(document.sourceId),
          );
          if (changed.length > 0) {
            await this.process.request(
              { op: 'index', source, slot: target, documents: changed },
              EMBEDDING_BATCH_TIMEOUT_MS,
            );
          }
        }
        if (gone.length > 0) {
          await this.process.request(
            { op: 'delete', source, sourceIds: gone },
            EMBEDDING_CONTROL_TIMEOUT_MS,
          );
        }
      } catch (err) {
        for (const id of ids) {
          queue.add(id);
        }
        throw err;
      }
      await this.refreshCounts(slot, progress);
      return true;
    }
    return false;
  }

  private async chatStep(
    slot: ModelSlot,
    progress: SlotProgress,
  ): Promise<boolean> {
    const chats = this.chatProvider;
    if (!chats) {
      return false;
    }
    await this.loadCursors(progress, chats);
    const cutoff = this.chatCutoff();
    const forward = progress.forward ?? 0;
    const fresh = await chats.after(forward, EMBEDDING_CHAT_STEP_ITEMS);
    if (fresh.length > 0) {
      const inWindow = withinWindow(fresh, cutoff);
      if (inWindow.length > 0) {
        await this.indexChats(slot, inWindow);
      }
      progress.forward = Math.max(...fresh.map((row) => row.rowid));
      await this.saveCursor(progress, 'fwd', progress.forward);
      await this.refreshCounts(slot, progress);
      return true;
    }
    if (progress.chatsDone) {
      return false;
    }
    const older = await chats.before(
      progress.back ?? 0,
      EMBEDDING_CHAT_STEP_ITEMS,
    );
    if (older.length === 0) {
      progress.chatsDone = true;
      await this.saveCursor(progress, 'back', 0);
      return false;
    }
    const kept = withinWindow(older, cutoff);
    if (kept.length === 0) {
      progress.chatsDone = true;
      return false;
    }
    await this.indexChats(slot, kept);
    progress.back = Math.min(...older.map((row) => row.rowid));
    await this.saveCursor(progress, 'back', progress.back);
    await this.refreshCounts(slot, progress);
    return true;
  }

  private async indexChats(
    slot: ModelSlot,
    rows: readonly {
      itemId: string;
      runId: string;
      createdAt: number;
      textHash: string;
      text: string;
    }[],
  ): Promise<void> {
    await this.process.request(
      {
        op: 'indexChats',
        slot,
        items: rows.map(({ itemId, runId, createdAt, textHash, text }) => ({
          itemId,
          runId,
          createdAt,
          textHash,
          text,
        })),
      },
      EMBEDDING_BATCH_TIMEOUT_MS,
    );
  }

  private async loadCursors(
    progress: SlotProgress,
    chats: ChatSourceProvider,
  ): Promise<void> {
    if (progress.forward !== null && progress.back !== null) {
      return;
    }
    const [forward, back] = await Promise.all([
      this.process.request(
        { op: 'getMeta', key: `chats:${progress.key}:fwd` },
        EMBEDDING_CONTROL_TIMEOUT_MS,
      ),
      this.process.request(
        { op: 'getMeta', key: `chats:${progress.key}:back` },
        EMBEDDING_CONTROL_TIMEOUT_MS,
      ),
    ]);
    if (forward === null || back === null) {
      const newest = await chats.newestRowid();
      progress.forward = newest;
      progress.back = newest + 1;
      await this.saveCursor(progress, 'fwd', progress.forward);
      await this.saveCursor(progress, 'back', progress.back);
      return;
    }
    progress.forward = Number(forward);
    progress.back = Number(back);
    progress.chatsDone = progress.back === 0;
    const newest = await chats.newestRowid();
    if (progress.forward > newest) {
      progress.forward = rewoundFloor(newest);
      await this.saveCursor(progress, 'fwd', progress.forward);
    }
  }

  /**
   * A deleted chat frees the newest `items` rowids, and SQLite hands them to
   * the next messages, below a forward cursor that had already passed them. The
   * cursors step back under them; rows walked twice cost the child only a hash
   * check.
   */
  private async rewindChatCursors(): Promise<void> {
    const chats = this.chatProvider;
    const models = [this.config.model, this.config.pendingModel].filter(
      (model): model is EmbeddingModelRef => model !== null,
    );
    if (!chats || models.length === 0) {
      return;
    }
    const floor = rewoundFloor(await chats.newestRowid());
    for (const slot of SLOTS) {
      const progress = this.progress[slot];
      if (progress && progress.forward !== null && progress.forward > floor) {
        progress.forward = floor;
      }
    }
    const keys = models.map(forwardCursorKey);
    if (this.process.alive) {
      try {
        for (const key of keys) {
          const value = await this.process.request(
            { op: 'getMeta', key },
            EMBEDDING_CONTROL_TIMEOUT_MS,
          );
          if (value !== null && Number(value) > floor) {
            await this.process.request(
              { op: 'setMeta', key, value: String(floor) },
              EMBEDDING_CONTROL_TIMEOUT_MS,
            );
          }
        }
        return;
      } catch (err) {
        this.logger.warn(
          `could not step the chat cursors back in the embedding child, writing the file: ${String(err)}`,
        );
      }
    }
    await this.writeIndexFile('could not step the chat cursors back', (db) =>
      db
        .updateTable('meta')
        .set({ value: String(floor) })
        .where('key', 'in', keys)
        .where(sql<number>`cast(value as integer)`, '>', floor)
        .execute(),
    );
  }

  private async saveCursor(
    progress: SlotProgress,
    which: 'fwd' | 'back',
    value: number,
  ): Promise<void> {
    await this.process.request(
      {
        op: 'setMeta',
        key: `chats:${progress.key}:${which}`,
        value: String(value),
      },
      EMBEDDING_CONTROL_TIMEOUT_MS,
    );
  }

  private async refreshCounts(
    slot: ModelSlot,
    progress: SlotProgress,
  ): Promise<void> {
    const counts = await this.process.request(
      { op: 'counts', slot },
      EMBEDDING_CONTROL_TIMEOUT_MS,
    );
    progress.counts = {
      memory: counts.memory,
      knowledge: counts.knowledge,
      chats: counts.chats,
    };
    progress.countsRead = true;
  }

  private refreshTotals(): Promise<void> {
    if (this.totalsReading) {
      return this.totalsReading;
    }
    if (Date.now() - this.totalsReadAt < EMBEDDING_TOTALS_FRESH_MS) {
      return Promise.resolve();
    }
    this.totalsReadAt = Date.now();
    this.totalsReading = this.readTotals().finally(() => {
      this.totalsReading = null;
    });
    return this.totalsReading;
  }

  private async readTotals(): Promise<void> {
    for (const source of DOCUMENT_SOURCES) {
      const provider = this.documentProviders.get(source);
      if (provider) {
        this.totals[source] = this.config.sources[source]
          ? (await provider.inventory()).length
          : 0;
      }
    }
    if (this.chatProvider) {
      this.totals.chats = this.config.sources.chats
        ? await this.chatProvider.total(this.chatCutoff())
        : 0;
    }
  }

  private slotComplete(slot: ModelSlot): boolean {
    const progress = this.progress[slot];
    if (!progress) {
      return false;
    }
    const documentsDone = DOCUMENT_SOURCES.every(
      (source) =>
        !this.documentProviders.has(source) ||
        !this.config.sources[source] ||
        progress.backfilled.has(source),
    );
    const chatsDone =
      this.chatProvider === null ||
      !this.config.sources.chats ||
      progress.chatsDone;
    return documentsDone && chatsDone && this.backlog() === 0;
  }

  private backlog(): number {
    let size = 0;
    for (const queue of this.jobs.values()) {
      size += queue.size;
    }
    return size;
  }

  private enqueueFor(source: DocumentSource, ids: readonly string[]): void {
    const queue = this.jobs.get(source);
    for (const id of ids) {
      queue?.add(id);
    }
  }

  private async deleteOrQueue(
    live: () => Promise<unknown>,
    rows: { source: string; source_id: string | null; run_id: string | null }[],
  ): Promise<void> {
    if (this.process.alive) {
      try {
        await live();
        return;
      } catch (err) {
        this.logger.warn(
          `could not delete vectors in the embedding child, queueing: ${String(err)}`,
        );
      }
    }
    const queuedAt = Date.now();
    await this.writeIndexFile('could not queue a vector deletion', (db) =>
      db
        .insertInto('deletions')
        .values(rows.map((row) => ({ ...row, queued_at: queuedAt })))
        .execute(),
    );
  }

  /** A write the daemon makes to the index file itself, while the child is down; none when the file does not exist. */
  private async writeIndexFile(
    failure: string,
    write: (db: Kysely<EmbeddingsDatabase>) => Promise<unknown>,
  ): Promise<void> {
    if (!existsSync(this.process.dbPath)) {
      return;
    }
    const raw = new DatabaseSync(this.process.dbPath);
    try {
      raw.exec('PRAGMA busy_timeout = 5000;');
      await write(kyselyOverNodeSqlite<EmbeddingsDatabase>(raw));
    } catch (err) {
      this.logger.warn(`${failure}: ${String(err)}`);
    } finally {
      raw.close();
    }
  }

  private indexBytes(): number {
    return ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(this.process.dbPath + suffix).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  private startTimers(): void {
    if (!this.chatPoll) {
      this.chatPoll = setInterval(
        () => void this.pollChats(),
        EMBEDDING_CHAT_POLL_MS,
      );
      this.chatPoll.unref();
    }
    if (!this.sweep) {
      this.sweep = setInterval(
        () => void this.sweepRuns(),
        EMBEDDING_SWEEP_INTERVAL_MS,
      );
      this.sweep.unref();
    }
  }

  private stopTimers(): void {
    for (const timer of [
      this.chatPoll,
      this.sweep,
      this.changedTimer,
      this.resumeTimer,
    ]) {
      if (timer) {
        clearInterval(timer);
      }
    }
    this.chatPoll = null;
    this.sweep = null;
    this.changedTimer = null;
    this.resumeTimer = null;
  }

  private async pollChats(): Promise<void> {
    const chats = this.chatProvider;
    const forward = this.progress.active?.forward;
    if (
      !chats ||
      forward === null ||
      forward === undefined ||
      this.config.onBattery ||
      !this.config.sources.chats
    ) {
      return;
    }
    if ((await chats.after(forward, 1)).length > 0) {
      this.kick();
    }
  }

  private async sweepRuns(): Promise<void> {
    const chats = this.chatProvider;
    if (!chats || !this.enabled) {
      return;
    }
    if (this.config.sources.chats && this.config.chatWindowDays !== null) {
      this.purgeDue = true;
      this.kick();
    }
    try {
      await this.process.request(
        { op: 'keepRuns', runIds: await chats.liveRunIds() },
        EMBEDDING_BATCH_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.warn(
        `the daily sweep of deleted chats' vectors failed: ${String(err)}`,
      );
    }
  }

  /** Epoch ms before which chats are left to word search, or null for all of them. */
  private chatCutoff(): number | null {
    const days = this.config.chatWindowDays;
    return days === null ? null : Date.now() - days * EMBEDDING_DAY_MS;
  }

  /** What a push changes at once in memory; the vectors it leaves out go in {@link purgeExcluded}, the next work's first step. */
  private applySources(): void {
    for (const source of DOCUMENT_SOURCES) {
      if (!this.config.sources[source]) {
        this.jobs.get(source)?.clear();
        this.totals[source] = 0;
        for (const slot of SLOTS) {
          this.progress[slot]?.backfilled.delete(source);
        }
      }
    }
    if (!this.config.sources.chats) {
      this.totals.chats = 0;
      this.forgetChatCursors();
    }
    this.totalsReadAt = 0;
    this.purgeDue = true;
  }

  private forgetChatCursors(): void {
    for (const slot of SLOTS) {
      const progress = this.progress[slot];
      if (progress) {
        progress.forward = null;
        progress.back = null;
        progress.chatsDone = false;
      }
    }
  }

  /**
   * Drops the vectors the settings leave out: every vector of a source
   * switched off, and chats older than the window. A window wider than the one
   * the index was last trimmed to walks the chats again from the newest, since
   * the cursors had passed the messages it now takes in. The stored window is
   * compared rather than the previous push, which a restart loses.
   */
  private async purgeExcluded(): Promise<void> {
    for (const source of EMBEDDING_SOURCES) {
      if (!this.config.sources[source]) {
        await this.process.request(
          { op: 'dropSource', source },
          EMBEDDING_BATCH_TIMEOUT_MS,
        );
      }
    }
    if (!this.config.sources.chats) {
      return;
    }
    const days = this.config.chatWindowDays;
    const stored =
      (await this.process.request(
        { op: 'getMeta', key: CHAT_WINDOW_KEY },
        EMBEDDING_CONTROL_TIMEOUT_MS,
      )) ?? ALL_TIME;
    if (widens(days, stored)) {
      this.forgetChatCursors();
      for (const model of [this.config.model, this.config.pendingModel]) {
        if (!model) {
          continue;
        }
        for (const which of ['fwd', 'back'] as const) {
          await this.process.request(
            {
              op: 'setMeta',
              key: `chats:${keyOf(model)}:${which}`,
              value: null,
            },
            EMBEDDING_CONTROL_TIMEOUT_MS,
          );
        }
      }
    }
    const cutoff = this.chatCutoff();
    if (cutoff !== null) {
      await this.process.request(
        { op: 'deleteChatsBefore', createdBefore: cutoff },
        EMBEDDING_BATCH_TIMEOUT_MS,
      );
    }
    if (windowValue(days) !== stored) {
      await this.process.request(
        { op: 'setMeta', key: CHAT_WINDOW_KEY, value: windowValue(days) },
        EMBEDDING_CONTROL_TIMEOUT_MS,
      );
    }
    for (const slot of SLOTS) {
      const progress = this.progress[slot];
      if (progress?.countsRead) {
        await this.refreshCounts(slot, progress);
      }
    }
  }

  private emit(reason: EmbeddingsChangedEvent['reason']): void {
    const now = Date.now();
    if (
      reason !== 'progress' ||
      now - this.lastChanged >= EMBEDDING_CHANGED_THROTTLE_MS
    ) {
      this.lastChanged = now;
      this.changed.next({ reason });
      return;
    }
    if (!this.changedTimer) {
      this.changedTimer = setTimeout(() => {
        this.changedTimer = null;
        this.lastChanged = Date.now();
        this.changed.next({ reason: 'progress' });
      }, EMBEDDING_CHANGED_THROTTLE_MS);
      this.changedTimer.unref();
    }
  }
}
