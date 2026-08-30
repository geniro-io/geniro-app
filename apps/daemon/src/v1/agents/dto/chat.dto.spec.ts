import { describe, expect, it } from 'vitest';

import { listChatsQuerySchema } from './chat.dto';

describe('listChatsQuerySchema', () => {
  /**
   * The trap `z.stringbool()` is here to avoid, driven rather than described.
   *
   * A query string carries the WORD `false`, and under `z.coerce.boolean()` a
   * non-empty string is truthy — so an explicit `?archived=false` would hand
   * back the archive. Swapping the schema for the obvious "simplification"
   * has to fail something, and this is the something.
   */
  it('reads the STRING "false" as false, not as a truthy string', () => {
    expect(listChatsQuerySchema.parse({ archived: 'false' }).archived).toBe(
      false,
    );
    expect(listChatsQuerySchema.parse({ archived: 'true' }).archived).toBe(
      true,
    );
  });

  it('leaves the side unstated when the param is absent', () => {
    // The caller resolves absent to the ACTIVE side; the schema must not
    // decide that for it by defaulting.
    expect(listChatsQuerySchema.parse({}).archived).toBeUndefined();
  });

  it('refuses a value that names neither side', () => {
    expect(() => listChatsQuerySchema.parse({ archived: 'maybe' })).toThrow();
  });
});
