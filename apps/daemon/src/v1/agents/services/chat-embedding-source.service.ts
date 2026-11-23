import { createHash } from 'node:crypto';

import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { filter } from 'rxjs/operators';

import type {
  ChatSourceProvider,
  ChatSourceRow,
} from '../../embeddings/embeddings.types';
import { EmbeddingIndexService } from '../../embeddings/services/embedding-index.service';
import {
  type ChatEmbeddableRow,
  ChatSearchIndexDao,
} from '../dao/chat-search-index.dao';
import { AgentEventBus } from './agent-events.bus';

function sourceRowOf(row: ChatEmbeddableRow): ChatSourceRow {
  return {
    rowid: row.rowid,
    itemId: row.id,
    runId: row.run_id,
    createdAt: row.created_at,
    textHash: createHash('sha256').update(row.text).digest('hex'),
    text: row.text,
  };
}

/**
 * Chat history as search by meaning reads it, and the cleanup that keeps a
 * deleted chat's vectors from outliving it.
 */
@Injectable()
export class ChatEmbeddingSourceService implements OnModuleInit {
  constructor(
    private readonly index: ChatSearchIndexDao,
    private readonly bus: AgentEventBus,
    @Optional() private readonly embeddings?: EmbeddingIndexService,
  ) {}

  onModuleInit(): void {
    const embeddings = this.embeddings;
    if (!embeddings) {
      return;
    }
    const provider: ChatSourceProvider = {
      total: () => this.index.embeddableCount(),
      newestRowid: () => this.index.newestItemRowid(),
      before: async (rowid, limit) =>
        (await this.index.embeddableRows(rowid, 'before', limit)).map(
          sourceRowOf,
        ),
      after: async (rowid, limit) =>
        (await this.index.embeddableRows(rowid, 'after', limit)).map(
          sourceRowOf,
        ),
      liveRunIds: () => this.index.liveRunIds(),
    };
    embeddings.registerChats(provider);
    this.bus.allDeleted().subscribe((runId) => {
      void embeddings.deleteRuns([runId]);
    });
    this.bus
      .all()
      .pipe(
        filter(
          ({ item }) =>
            item.kind === 'message' &&
            (item.role === 'user' || item.role === 'assistant'),
        ),
      )
      .subscribe(() => embeddings.chatAdded());
  }
}
