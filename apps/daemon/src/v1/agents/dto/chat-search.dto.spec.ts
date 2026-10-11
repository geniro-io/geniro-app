import { describe, expect, it } from 'vitest';

import { GlobalChatSearchQueryDto } from './chat-search.dto';

describe('GlobalChatSearchQueryDto', () => {
  const parse = (query: Record<string, string>) =>
    GlobalChatSearchQueryDto.schema.safeParse(query);

  it('reads the query string’s text forms as a number and a boolean', () => {
    expect(
      parse({ query: 'retry', limit: '5', includeArchived: 'false' }).data,
    ).toMatchObject({ query: 'retry', limit: 5, includeArchived: false });
    expect(
      parse({ query: 'retry', includeArchived: 'true' }).data,
    ).toMatchObject({ includeArchived: true });
  });

  it('defaults to thirty hits with archived chats included', () => {
    expect(parse({ query: 'retry' }).data).toMatchObject({
      limit: 30,
      includeArchived: true,
    });
  });

  it('refuses a boolean spelled any other way, rather than reading it as true', () => {
    expect(parse({ query: 'retry', includeArchived: '0' }).success).toBe(false);
    expect(parse({ query: 'retry', includeArchived: 'no' }).success).toBe(
      false,
    );
  });

  it('refuses a limit outside its bounds', () => {
    expect(parse({ query: 'retry', limit: '0' }).success).toBe(false);
    expect(parse({ query: 'retry', limit: '101' }).success).toBe(false);
    expect(parse({ query: 'retry', limit: 'many' }).success).toBe(false);
  });
});
