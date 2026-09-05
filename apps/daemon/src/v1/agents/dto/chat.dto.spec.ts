import { describe, expect, it } from 'vitest';

import {
  createChatSchema,
  listChatsQuerySchema,
  searchChatQuerySchema,
} from './chat.dto';

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

describe('searchChatQuerySchema', () => {
  it('coerces the limit a query string carries as text', () => {
    // Everything in a query string is a string; without the coercion the route
    // would refuse every request that named a limit at all.
    expect(
      searchChatQuerySchema.parse({ query: 'bloom', limit: '25' }).limit,
    ).toBe(25);
  });

  it('leaves the limit unstated when the caller does not name one', () => {
    // The service owns the default, so the schema must not decide it here —
    // two answers to one question is how they come to disagree.
    expect(
      searchChatQuerySchema.parse({ query: 'bloom' }).limit,
    ).toBeUndefined();
  });

  it('refuses a limit outside its bounds', () => {
    // `limit` is the only client-supplied bound on a scan over one
    // conversation's rows, and zero would ask for a search that answers nothing.
    expect(() =>
      searchChatQuerySchema.parse({ query: 'bloom', limit: '0' }),
    ).toThrow();
    expect(() =>
      searchChatQuerySchema.parse({ query: 'bloom', limit: '201' }),
    ).toThrow();
  });

  it('refuses a query that is absent, blank, or absurdly long', () => {
    expect(() => searchChatQuerySchema.parse({})).toThrow();
    expect(() => searchChatQuerySchema.parse({ query: '   ' })).toThrow();
    expect(() =>
      searchChatQuerySchema.parse({ query: 'x'.repeat(201) }),
    ).toThrow();
  });
});

describe('createChatSchema — the run-start git stamp', () => {
  const base = { agentKind: 'claude', cwd: '/work/app' } as const;
  const sha = 'a'.repeat(40);

  it('takes a commit id and the dirty flag beside it', () => {
    const parsed = createChatSchema.parse({
      ...base,
      startSha: sha,
      startDirty: true,
    });
    expect(parsed.startSha).toBe(sha);
    expect(parsed.startDirty).toBe(true);
  });

  it('leaves both unstated when the client had nothing to stamp', () => {
    // A folder that is not a repository is a real answer, not a failure — the
    // chat opens unstamped rather than being refused.
    const parsed = createChatSchema.parse(base);
    expect(parsed.startSha).toBeUndefined();
    expect(parsed.startDirty).toBeUndefined();
  });

  it('refuses anything that is not a full commit id', () => {
    // The value becomes argv to `git`, so the shape is checked at the edge
    // rather than by each reader downstream. An abbreviated sha is refused for
    // the same reason a word is: what is stored has to name exactly one commit.
    expect(() =>
      createChatSchema.parse({ ...base, startSha: 'HEAD' }),
    ).toThrow();
    expect(() =>
      createChatSchema.parse({ ...base, startSha: sha.slice(0, 7) }),
    ).toThrow();
    expect(() =>
      createChatSchema.parse({ ...base, startSha: `${sha}0` }),
    ).toThrow();
    expect(() =>
      createChatSchema.parse({ ...base, startSha: 'A'.repeat(40) }),
    ).toThrow();
  });
});
