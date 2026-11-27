import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../agents/chat.types';
import { AnalysisRunsQuerySchema, AnswerHeldRunsSchema } from '../teams.types';
import { runTeamSchema } from './teams.dto';

const IMAGE = { mediaType: 'image/png', data: 'aGk=' } as const;

describe('AnswerHeldRunsSchema', () => {
  it('takes both lists of run ids', () => {
    expect(
      AnswerHeldRunsSchema.parse({
        continueRunIds: ['run-1'],
        declineRunIds: [],
      }),
    ).toEqual({ continueRunIds: ['run-1'], declineRunIds: [] });
  });

  it.each([
    [{ continueRunIds: ['run-1'] }],
    [{ continueRunIds: [7], declineRunIds: [] }],
    [{ continueRunIds: 'run-1', declineRunIds: [] }],
  ])('refuses an answer that does not name two lists of ids: %j', (body) => {
    expect(AnswerHeldRunsSchema.safeParse(body).success).toBe(false);
  });
});

describe('AnalysisRunsQuerySchema', () => {
  it('reads the period from the query string, 1 to 365 whole days', () => {
    expect(AnalysisRunsQuerySchema.parse({ days: '7' }).days).toBe(7);
    for (const days of ['0', '366', '1.5', 'x']) {
      expect(AnalysisRunsQuerySchema.safeParse({ days }).success).toBe(false);
    }
    expect(AnalysisRunsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('runTeamSchema', () => {
  it('starts a run from pasted images alone, as a chat message may', () => {
    expect(
      runTeamSchema.safeParse({ cwd: '/w', prompt: '', images: [IMAGE] })
        .success,
    ).toBe(true);
  });

  it('refuses a start carrying neither a task nor an image', () => {
    expect(runTeamSchema.safeParse({ cwd: '/w', prompt: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses more images than one message may carry, or a type it may not', () => {
    expect(
      runTeamSchema.safeParse({
        cwd: '/w',
        prompt: 'go',
        images: Array.from(
          { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
          () => IMAGE,
        ),
      }).success,
    ).toBe(false);
    expect(
      runTeamSchema.safeParse({
        cwd: '/w',
        prompt: 'go',
        images: [{ mediaType: 'application/pdf', data: 'aGk=' }],
      }).success,
    ).toBe(false);
  });
});
