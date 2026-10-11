import { describe, expect, it } from 'vitest';

import {
  CHAT_TEXT_TRIGGERS,
  CHAT_TEXT_VERSION,
  retiredTriggerDrops,
} from './chat-text-index.ddl';

describe('chat text index DDL', () => {
  it('lists, for a version bump, a drop for every trigger the previous versions created', () => {
    expect(retiredTriggerDrops(1)).toEqual([]);
    expect(retiredTriggerDrops(3)).toEqual([
      'DROP TRIGGER IF EXISTS chat_text_v1_after_insert',
      'DROP TRIGGER IF EXISTS chat_text_v1_after_update',
      'DROP TRIGGER IF EXISTS chat_text_v1_after_delete',
      'DROP TRIGGER IF EXISTS chat_text_v2_after_insert',
      'DROP TRIGGER IF EXISTS chat_text_v2_after_update',
      'DROP TRIGGER IF EXISTS chat_text_v2_after_delete',
    ]);
  });

  it('names every current trigger the way a later version will drop it', () => {
    for (const trigger of CHAT_TEXT_TRIGGERS) {
      expect(trigger.sql).toContain(
        `CREATE TRIGGER IF NOT EXISTS ${trigger.name} `,
      );
      expect(retiredTriggerDrops(CHAT_TEXT_VERSION + 1)).toContain(
        `DROP TRIGGER IF EXISTS ${trigger.name}`,
      );
    }
  });
});
