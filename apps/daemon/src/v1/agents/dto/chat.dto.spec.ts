import { describe, expect, it } from 'vitest';

import { listChatsQuerySchema } from './chat.dto';

describe('listChatsQuerySchema', () => {
  it('reads each of the three scopes a query string can carry', () => {
    expect(listChatsQuerySchema.parse({ scope: 'active' }).scope).toBe(
      'active',
    );
    expect(listChatsQuerySchema.parse({ scope: 'all' }).scope).toBe('all');
    expect(listChatsQuerySchema.parse({ scope: 'archived' }).scope).toBe(
      'archived',
    );
  });

  it('leaves the scope unstated when the param is absent', () => {
    // The caller resolves absent to ACTIVE; the schema must not decide that
    // for it by defaulting, or the two would be free to disagree.
    expect(listChatsQuerySchema.parse({}).scope).toBeUndefined();
  });

  it('refuses a value that names no scope', () => {
    expect(() => listChatsQuerySchema.parse({ scope: 'maybe' })).toThrow();
    // The boolean this replaced: a query string carries the WORD, and a schema
    // that coerced it would read `false` as truthy and hand back the archive.
    // Under the enum it is simply not a scope.
    expect(() => listChatsQuerySchema.parse({ scope: 'false' })).toThrow();
  });
});
