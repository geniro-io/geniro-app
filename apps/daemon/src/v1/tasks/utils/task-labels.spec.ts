import { describe, expect, it } from 'vitest';

import { parseLabels } from './task-labels';

describe('parseLabels', () => {
  it('decodes a JSON array of strings', () => {
    expect(parseLabels('["bug","frontend"]')).toEqual(['bug', 'frontend']);
  });

  it('answers an empty list for an empty array', () => {
    expect(parseLabels('[]')).toEqual([]);
  });

  it('drops non-string entries rather than failing the whole read', () => {
    expect(parseLabels('["bug",1,null,"ok"]')).toEqual(['bug', 'ok']);
  });

  it('answers an empty list for a JSON value that is not an array', () => {
    expect(parseLabels('{"not":"an array"}')).toEqual([]);
  });

  it('answers an empty list for text that is not JSON at all — a corrupt row must not throw', () => {
    expect(parseLabels('not json')).toEqual([]);
  });
});
