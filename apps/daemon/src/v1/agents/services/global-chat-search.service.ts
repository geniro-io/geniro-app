import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import {
  searchTerms,
  snippetAround,
} from '../adapters/utils/session-search.utils';
import {
  type ChatEmbeddedChunk,
  type ChatEmbeddingModel,
  type GlobalChatSearchHit,
  type GlobalChatSearchQuery,
  GlobalChatSearchQuerySchema,
  type GlobalChatSearchResult,
  type GlobalChatSearchRow,
} from '../chat-search.types';
import { ChatSearchIndexDao } from '../dao/chat-search-index.dao';
import {
  cosineSimilarity,
  searchChunks,
  searchTextHash,
} from '../utils/chat-search-vectors';
import { fullSearchableText } from '../utils/searchable-text';
import { ChatEmbeddingsService } from './chat-embeddings.service';

interface RankedHit {
  row: GlobalChatSearchRow;
  score: number;
  textOffset: number | null;
}

function fullText(payload: string, fallback: string): string {
  try {
    return fullSearchableText(JSON.parse(payload) as unknown) ?? fallback;
  } catch {
    return fallback;
  }
}

@Injectable()
export class GlobalChatSearchService implements OnApplicationShutdown {
  private indexing: Promise<void> | null = null;
  private lastScan = 0;
  private lastModelKey: string | null = null;
  private indexError: string | null = null;
  private stopped = false;

  constructor(
    private readonly index: ChatSearchIndexDao,
    private readonly embeddings: ChatEmbeddingsService,
  ) {}

  async search(input: GlobalChatSearchQuery): Promise<GlobalChatSearchResult> {
    const options = GlobalChatSearchQuerySchema.parse(input);
    const terms = searchTerms(options.query);
    const cap = Math.max(options.limit * 3, 50);
    const keywords = await this.index.keywords(options, terms, cap + 1);
    let mode = options.mode;
    let model: ChatEmbeddingModel | null = null;
    let reason: string | null = null;
    let semantic: RankedHit[] = [];
    if (mode !== 'keyword') {
      try {
        model = await this.embeddings.model();
        if (!model) {
          throw new Error(
            'Install a local Ollama embedding model (ollama pull embeddinggemma).',
          );
        }
        this.startIndex(model);
        const [queryVector] = await this.embeddings.embed(model, [
          options.query,
        ]);
        if (!queryVector) {
          throw new Error('Ollama returned no query embedding.');
        }
        semantic = await this.nearest(options, model.key, queryVector, cap);
      } catch (error) {
        mode = 'keyword';
        model = null;
        reason = `Using text search. Semantic search is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const ranked = new Map<string, RankedHit>();
    if (mode !== 'semantic') {
      keywords.slice(0, cap).forEach((row, rank) => {
        ranked.set(row.id, {
          row,
          score: mode === 'keyword' ? 1 / (rank + 1) : 1 / (60 + rank + 1),
          textOffset: null,
        });
      });
    }
    if (mode !== 'keyword') {
      semantic.forEach((hit, rank) => {
        const existing = ranked.get(hit.row.id);
        ranked.set(hit.row.id, {
          ...hit,
          score:
            mode === 'semantic'
              ? hit.score
              : (existing?.score ?? 0) + 1 / (60 + rank + 1),
        });
      });
    }
    const selected = [...ranked.values()]
      .sort((a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt)
      .slice(0, options.limit);
    const payloads = await this.index.payloads(
      selected.map((hit) => hit.row.id),
    );
    const hits: GlobalChatSearchHit[] = selected.flatMap((hit) => {
      const payload = payloads.get(hit.row.id);
      if (payload === undefined) {
        return [];
      }
      const text = fullText(payload, hit.row.searchText);
      const term =
        hit.textOffset === null
          ? terms.find((candidate) => text.toLowerCase().includes(candidate))
          : undefined;
      return [
        {
          runId: hit.row.runId,
          nodeId: hit.row.nodeId,
          title: hit.row.title,
          cwd: hit.row.cwd,
          archived: hit.row.archivedAt !== null,
          seq: hit.row.seq,
          kind: hit.row.kind,
          role: hit.row.role,
          snippet: snippetAround(
            text,
            term ?? '',
            240,
            hit.textOffset ?? undefined,
          ),
          createdAt: new Date(hit.row.createdAt).toISOString(),
          score: hit.score,
        },
      ];
    });
    const indexing = mode !== 'keyword' && this.indexing !== null;
    const notices = [
      reason,
      mode === 'keyword'
        ? 'Text search uses indexed previews and may omit text deep inside long messages.'
        : null,
      indexing
        ? 'Indexing older messages locally — semantic results will expand. Search again shortly.'
        : null,
      mode !== 'keyword' ? this.indexError : null,
      ranked.size > options.limit || keywords.length > cap
        ? `Showing the top ${options.limit} matches. Narrow the query for more specific results.`
        : null,
    ].filter(Boolean);
    return {
      hits,
      mode,
      model: model?.name ?? null,
      indexing,
      partialReason: notices.join(' ') || null,
    };
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  private startIndex(model: ChatEmbeddingModel): void {
    if (
      this.stopped ||
      this.indexing ||
      (model.key === this.lastModelKey && Date.now() - this.lastScan < 5_000)
    ) {
      return;
    }
    this.indexError = null;
    const job = this.buildIndex(model)
      .catch((error) => {
        this.indexError = `Semantic indexing paused: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        this.lastScan = Date.now();
        this.lastModelKey = model.key;
        if (this.indexing === job) {
          this.indexing = null;
        }
      });
    this.indexing = job;
  }

  private async buildIndex(model: ChatEmbeddingModel): Promise<void> {
    await this.index.prune();
    let afterId = '';
    while (!this.stopped) {
      const documents = await this.index.documents(afterId, model.key);
      if (!documents.length) {
        return;
      }
      for (const document of documents) {
        if (this.stopped) {
          return;
        }
        const hash = searchTextHash(document.payload);
        if (hash === document.textHash) {
          continue;
        }
        const chunks = searchChunks(
          fullText(document.payload, document.searchText),
        );
        const vectors: ChatEmbeddedChunk[] = [];
        for (let start = 0; start < chunks.length; start += 16) {
          if (this.stopped) {
            return;
          }
          vectors.push(
            ...(await this.embeddings.embedChunks(
              model,
              chunks.slice(start, start + 16),
            )),
          );
        }
        await this.index.save(document, model.key, hash, vectors);
      }
      afterId = documents[documents.length - 1]!.id;
    }
  }

  private async nearest(
    options: GlobalChatSearchQuery,
    modelKey: string,
    query: number[],
    cap: number,
  ): Promise<RankedHit[]> {
    const best = new Map<string, RankedHit>();
    let afterId = '';
    let afterChunk = -1;
    while (true) {
      const rows = await this.index.vectors(
        options,
        modelKey,
        afterId,
        afterChunk,
      );
      if (!rows.length) {
        break;
      }
      const payloads = await this.index.payloads([
        ...new Set(rows.map((row) => row.id)),
      ]);
      const hashes = new Map(
        [...payloads].map(([id, payload]) => [id, searchTextHash(payload)]),
      );
      for (const row of rows) {
        if (hashes.get(row.id) !== row.textHash) {
          continue;
        }
        const vector: unknown = JSON.parse(row.vector);
        if (
          !Array.isArray(vector) ||
          !vector.every(
            (value) => typeof value === 'number' && Number.isFinite(value),
          )
        ) {
          continue;
        }
        const score = cosineSimilarity(query, vector as number[]);
        if (score < 0.25 || score <= (best.get(row.id)?.score ?? -1)) {
          continue;
        }
        best.set(row.id, { row, score, textOffset: row.textOffset });
        if (best.size > cap) {
          const worst = [...best.values()].reduce((a, b) =>
            a.score < b.score ? a : b,
          );
          best.delete(worst.row.id);
        }
      }
      const last = rows[rows.length - 1]!;
      afterId = last.id;
      afterChunk = last.chunkIndex;
    }
    return [...best.values()].sort(
      (a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt,
    );
  }
}
