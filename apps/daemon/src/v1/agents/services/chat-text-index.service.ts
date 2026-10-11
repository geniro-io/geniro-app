import { Injectable, Logger } from '@nestjs/common';

import { CHAT_TEXT_TRIGGERS } from '../../../db/chat-text-index.ddl';
import { ChatSearchIndexDao } from '../dao/chat-search-index.dao';

/**
 * Makes sure the chat full-text index exists and is complete — once, at boot,
 * after the schema sync and before the server listens.
 *
 * After that the triggers keep it current inside every write, so nothing else
 * ever has to think about it. The one thing they cannot survive is the table
 * they hang off being rebuilt, and that is detectable for free: a missing
 * trigger means the index is no longer trustworthy and is filled again from
 * `items`, which takes seconds even on a large history. A first boot after the
 * update takes the same path, because there are no triggers yet.
 */
@Injectable()
export class ChatTextIndexService {
  private readonly logger = new Logger(ChatTextIndexService.name);

  constructor(private readonly index: ChatSearchIndexDao) {}

  /**
   * Never throws: search being unavailable must not keep the daemon from
   * starting. A failure is logged and the next boot tries again.
   */
  async ensure(): Promise<void> {
    try {
      await this.index.createTable();
      const present = await this.index.presentTriggers();
      if (present.size === CHAT_TEXT_TRIGGERS.length) {
        return;
      }
      const started = Date.now();
      await this.index.rebuild();
      this.logger.log(
        `built the chat search index in ${Date.now() - started}ms`,
      );
    } catch (error) {
      this.logger.error(
        `could not build the chat search index — search across chats is unavailable until the next launch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
