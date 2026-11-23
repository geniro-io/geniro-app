import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { EmbeddingsController } from './controllers/embeddings.controller';
import { EmbeddingIndexService } from './services/embedding-index.service';
import { EmbeddingProcessService } from './services/embedding-process.service';

/**
 * Search by meaning (`v1/embeddings`): the embedding child, its index and the
 * queries memory, knowledge and chat search fuse with their word matches.
 *
 * It imports no feature module: memory, knowledge and the agents module
 * register what it embeds (`registerDocuments`, `registerChats`), so each of
 * them can import this one without a cycle.
 */
@Module({
  controllers: [EmbeddingsController],
  providers: [DesktopOnlyGuard, EmbeddingProcessService, EmbeddingIndexService],
  exports: [EmbeddingProcessService, EmbeddingIndexService],
})
export class EmbeddingsModule {}
