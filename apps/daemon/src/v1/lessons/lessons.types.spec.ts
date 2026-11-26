import { describe, expect, it } from 'vitest';

import {
  LESSON_HISTORY_BUCKETS,
  LESSON_HISTORY_PAGE_DEFAULT,
  LESSON_HISTORY_PAGE_MAX,
  LESSON_PROPOSAL_STATUSES,
  LessonHistoryQuerySchema,
  LessonProposalListQuerySchema,
} from './lessons.types';

describe('LessonProposalListQuerySchema', () => {
  it('reads a status list the query parser split at its commas as the comma list', () => {
    expect(
      LessonProposalListQuerySchema.parse({
        status: ['proposed', 'check_failed'],
      }),
    ).toEqual({ status: 'proposed,check_failed' });
  });

  it('keeps an encoded comma list and an absent status as they are', () => {
    expect(
      LessonProposalListQuerySchema.parse({ status: 'proposed,check_failed' }),
    ).toEqual({ status: 'proposed,check_failed' });
    expect(LessonProposalListQuerySchema.parse({})).toEqual({});
  });
});

describe('LESSON_HISTORY_BUCKETS', () => {
  it('puts every lesson status in exactly one bucket', () => {
    const bucketed: string[] = Object.values(LESSON_HISTORY_BUCKETS).flat();

    expect([...bucketed].sort()).toEqual([...LESSON_PROPOSAL_STATUSES].sort());
  });
});

describe('LessonHistoryQuerySchema', () => {
  it('reads a page of the default size when no limit is given', () => {
    expect(LessonHistoryQuerySchema.parse({})).toEqual({
      limit: LESSON_HISTORY_PAGE_DEFAULT,
    });
    expect(LessonHistoryQuerySchema.parse({ limit: '7' })).toEqual({
      limit: 7,
    });
  });

  it('refuses a page of none, one past the cap, and an overlong cursor', () => {
    expect(LessonHistoryQuerySchema.safeParse({ limit: 0 }).success).toBe(
      false,
    );
    expect(
      LessonHistoryQuerySchema.safeParse({ limit: LESSON_HISTORY_PAGE_MAX + 1 })
        .success,
    ).toBe(false);
    expect(
      LessonHistoryQuerySchema.safeParse({ before: 'x'.repeat(401) }).success,
    ).toBe(false);
  });
});
