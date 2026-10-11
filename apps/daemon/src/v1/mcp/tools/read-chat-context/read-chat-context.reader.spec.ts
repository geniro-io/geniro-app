import { describe, expect, it } from 'vitest';

import { readChatContextArgs } from './read-chat-context.reader';

const RUN = '00000000-0000-4000-8000-0000000000aa';

describe('readChatContextArgs', () => {
  it('reads a hit with three neighbours each side by default', () => {
    expect(readChatContextArgs({ runId: RUN, itemId: 'm1' })).toEqual({
      ok: true,
      query: { runId: RUN, itemId: 'm1', before: 3, after: 3 },
    });
  });

  it('reads a null count as unset', () => {
    expect(
      readChatContextArgs({ runId: RUN, itemId: 'm1', before: null }),
    ).toMatchObject({ ok: true, query: { before: 3 } });
  });

  it('refuses an argument it does not read', () => {
    expect(
      readChatContextArgs({ runId: RUN, itemId: 'm1', before_count: 1 }).ok,
    ).toBe(false);
  });

  it('refuses a run id that is not a uuid', () => {
    expect(readChatContextArgs({ runId: 'run-1', itemId: 'm1' }).ok).toBe(
      false,
    );
  });
});
