import type {
  ChatScore,
  DocumentSource,
  SourceScore,
} from '../embeddings.types';
import type { EmbeddingIndexService } from '../services/embedding-index.service';

export interface MeaningQuery {
  source: DocumentSource;
  query: string;
  sourceIds: readonly string[] | null;
  limit: number;
}

export interface ChatMeaningQuery {
  query: string;
  k: number;
  runIds: readonly string[] | null;
}

/**
 * The embedding index as the search modules see it: whether search by meaning
 * is on, what a query finds, and a record of the texts they hand it. Each spec
 * scripts the answers; no child process and no model are involved.
 */
export class FakeEmbeddingIndex {
  enabled = true;
  readonly scoreCalls: MeaningQuery[] = [];
  readonly chatCalls: ChatMeaningQuery[] = [];
  readonly enqueued: { source: DocumentSource; sourceIds: string[] }[] = [];
  readonly deleted: { source: DocumentSource; sourceIds: string[] }[] = [];
  readonly deletedRuns: string[][] = [];
  answerScores: (
    call: MeaningQuery,
  ) => SourceScore[] | null | Promise<SourceScore[] | null> = () => null;
  answerChats: (
    call: ChatMeaningQuery,
  ) => ChatScore[] | null | Promise<ChatScore[] | null> = () => null;

  async scoreDocuments(
    source: DocumentSource,
    query: string,
    sourceIds: readonly string[] | null,
    limit: number,
  ): Promise<SourceScore[] | null> {
    const call = { source, query, sourceIds, limit };
    this.scoreCalls.push(call);
    return this.answerScores(call);
  }

  async searchChats(
    query: string,
    k: number,
    runIds: readonly string[] | null,
  ): Promise<ChatScore[] | null> {
    const call = { query, k, runIds };
    this.chatCalls.push(call);
    return this.answerChats(call);
  }

  enqueue(source: DocumentSource, sourceIds: readonly string[]): void {
    this.enqueued.push({ source, sourceIds: [...sourceIds] });
  }

  async deleteDocuments(
    source: DocumentSource,
    sourceIds: readonly string[],
  ): Promise<void> {
    this.deleted.push({ source, sourceIds: [...sourceIds] });
  }

  async deleteRuns(runIds: readonly string[]): Promise<void> {
    this.deletedRuns.push([...runIds]);
  }
}

/** The fake, typed as the index it stands in for: the modules take the real class. */
export function asEmbeddingIndex(
  fake: FakeEmbeddingIndex,
): EmbeddingIndexService {
  return fake as unknown as EmbeddingIndexService;
}
