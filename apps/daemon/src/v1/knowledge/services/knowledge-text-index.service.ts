import { Injectable, Logger } from '@nestjs/common';

import { KNOWLEDGE_TEXT_TRIGGERS } from '../../../db/knowledge-text-index.ddl';
import { KnowledgeDocumentDao } from '../dao/knowledge-document.dao';

/**
 * Makes sure the knowledge full-text index exists and is complete — once, at
 * boot, after the schema sync and before the server listens — the way
 * `MemoryTextIndexService` does for memory. The rank setting lives in the
 * table's own config, so it runs before the early return and after a rebuild.
 */
@Injectable()
export class KnowledgeTextIndexService {
  private readonly logger = new Logger(KnowledgeTextIndexService.name);

  constructor(private readonly documents: KnowledgeDocumentDao) {}

  /** Never throws: a failure is logged and the next boot tries again. */
  async ensure(): Promise<void> {
    try {
      await this.documents.createTable();
      await this.documents.setRank();
      const present = await this.documents.presentTriggers();
      if (present.size === KNOWLEDGE_TEXT_TRIGGERS.length) {
        return;
      }
      await this.documents.rebuild();
      await this.documents.setRank();
      this.logger.log('built the knowledge search index');
    } catch (error) {
      this.logger.error(
        `could not build the knowledge search index — knowledge_search finds nothing until the next launch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
