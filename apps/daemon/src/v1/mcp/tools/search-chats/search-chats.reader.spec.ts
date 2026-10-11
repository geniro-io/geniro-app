import { describe, expect, it } from 'vitest';

import { readSearchChatsArgs } from './search-chats.reader';

describe('readSearchChatsArgs', () => {
  it('reads a query with its defaults filled in', () => {
    expect(readSearchChatsArgs({ query: '  idempot  ' })).toEqual({
      ok: true,
      query: { query: 'idempot', limit: 30, includeArchived: true },
    });
  });

  it('reads a null optional argument as unset rather than refusing it', () => {
    expect(
      readSearchChatsArgs({ query: 'retry', runId: null, cwd: null }),
    ).toMatchObject({ ok: true, query: { query: 'retry' } });
  });

  it('refuses an argument it does not read, rather than widening the search', () => {
    const read = readSearchChatsArgs({ query: 'retry', run_id: 'x' });
    expect(read.ok).toBe(false);
  });

  it('refuses a query too short to search', () => {
    expect(readSearchChatsArgs({ query: 'x' }).ok).toBe(false);
  });
});
