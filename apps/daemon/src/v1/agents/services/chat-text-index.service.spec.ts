import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { chatSearchDb } from '../__tests__/chat-search-db';
import type { ChatSearchIndexDao } from '../dao/chat-search-index.dao';
import { ChatTextIndexService } from './chat-text-index.service';

describe('ChatTextIndexService', () => {
  it('rebuilds only when a trigger is missing', async () => {
    const db = await chatSearchDb();
    try {
      const dao = db.dao();
      const rebuild = vi.spyOn(dao, 'rebuild');
      const service = new ChatTextIndexService(dao);
      await service.ensure();
      await service.ensure();
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      await db.orm.close(true);
    }
  });

  it('logs and returns rather than failing the boot when the index cannot be built', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const dao = {
      createTable: vi.fn().mockRejectedValue(new Error('no fts5 here')),
    } as unknown as ChatSearchIndexDao;
    try {
      await expect(
        new ChatTextIndexService(dao).ensure(),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('no fts5 here'),
      );
    } finally {
      logged.mockRestore();
    }
  });
});
