import { describe, expect, it } from 'vitest';

import { listChatsQuerySchema } from '../dto/chat.dto';
import { runListPageOf } from './run-list-page';

describe('runListPageOf', () => {
  it('names no page for a query that asks for none', () => {
    expect(runListPageOf(listChatsQuerySchema.parse({ scope: 'all' }))).toEqual(
      {},
    );
  });

  it('reads the limit, the cursor and the one run off a query string', () => {
    const page = runListPageOf(
      listChatsQuerySchema.parse({
        scope: 'archived',
        limit: '50',
        beforeCreatedAt: '2026-10-01T10:00:00.000Z',
        beforeId: 'run-9',
        runId: 'run-3',
      }),
    );

    expect(page).toEqual({
      limit: 50,
      before: {
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        id: 'run-9',
      },
      runId: 'run-3',
    });
  });

  it('refuses half a cursor', () => {
    expect(
      listChatsQuerySchema.safeParse({
        beforeCreatedAt: '2026-10-01T10:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(listChatsQuerySchema.safeParse({ beforeId: 'run-9' }).success).toBe(
      false,
    );
  });
});
