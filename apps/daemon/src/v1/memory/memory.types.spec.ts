import { describe, expect, it } from 'vitest';

import {
  MEMORY_FORGET_BATCH_MAX,
  MEMORY_REVIEW_LIMIT_MAX,
  MemoryForgetBatchRequestSchema,
  MemoryReviewQuerySchema,
} from './memory.types';

describe('MemoryReviewQuerySchema', () => {
  const ok = (query: object) =>
    MemoryReviewQuerySchema.safeParse(query).success;

  it('takes a project scope only together with its project id', () => {
    expect(ok({ scope: 'project' })).toBe(false);
    expect(ok({ scope: 'project', projectId: 'p1' })).toBe(true);
    expect(ok({ projectId: 'p1' })).toBe(false);
  });

  it('takes a limit up to MEMORY_REVIEW_LIMIT_MAX and no more', () => {
    expect(ok({ limit: MEMORY_REVIEW_LIMIT_MAX })).toBe(true);
    expect(ok({ limit: MEMORY_REVIEW_LIMIT_MAX + 1 })).toBe(false);
  });

  it('takes a cursor of digits only', () => {
    expect(ok({ cursor: '2' })).toBe(true);
    expect(ok({ cursor: 'abc' })).toBe(false);
  });

  it('reads a minimum age given as text as a number', () => {
    expect(MemoryReviewQuerySchema.parse({ minAgeDays: '14' }).minAgeDays).toBe(
      14,
    );
  });
});

describe('MemoryForgetBatchRequestSchema', () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, n) => `e${n}`);
  const ok = (body: object) =>
    MemoryForgetBatchRequestSchema.safeParse(body).success;

  it('takes between one and MEMORY_FORGET_BATCH_MAX ids', () => {
    expect(ok({ ids: [] })).toBe(false);
    expect(ok({ ids: ids(1) })).toBe(true);
    expect(ok({ ids: ids(MEMORY_FORGET_BATCH_MAX) })).toBe(true);
    expect(ok({ ids: ids(MEMORY_FORGET_BATCH_MAX + 1) })).toBe(false);
  });
});
