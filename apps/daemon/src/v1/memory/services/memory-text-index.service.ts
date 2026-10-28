import { Injectable, Logger } from '@nestjs/common';

import { MEMORY_TEXT_TRIGGERS } from '../../../db/memory-text-index.ddl';
import { MemoryDao } from '../dao/memory.dao';

/**
 * Makes sure the memory full-text index exists and is complete — once, at
 * boot, after the schema sync and before the server listens — the way
 * `ChatTextIndexService` does for chats.
 */
@Injectable()
export class MemoryTextIndexService {
  private readonly logger = new Logger(MemoryTextIndexService.name);

  constructor(private readonly memories: MemoryDao) {}

  /**
   * Never throws: memory search being unavailable must not keep the daemon
   * from starting. A failure is logged and the next boot tries again.
   */
  async ensure(): Promise<void> {
    try {
      await this.memories.createTable();
      const present = await this.memories.presentTriggers();
      if (present.size === MEMORY_TEXT_TRIGGERS.length) {
        return;
      }
      await this.memories.rebuild();
      this.logger.log('built the memory search index');
    } catch (error) {
      this.logger.error(
        `could not build the memory search index — memory_search finds nothing until the next launch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
