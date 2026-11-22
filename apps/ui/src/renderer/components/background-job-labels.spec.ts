import { describe, expect, it } from 'vitest';

import { backgroundJob, JOBS_NOW } from '../__fixtures__/background-jobs';
import {
  backgroundJobMeta,
  backgroundJobResult,
  backgroundJobThread,
  backgroundJobWaitsForReview,
} from './background-job-labels';

describe('backgroundJobResult', () => {
  it('says what a finished lessons run filed', () => {
    expect(backgroundJobResult(backgroundJob())).toBe(
      '2 lessons saved · 1 lesson waiting for review',
    );
    expect(
      backgroundJobResult(
        backgroundJob({ lessons: { saved: 1, waiting: 0, dropped: 2 } }),
      ),
    ).toBe('1 lesson saved · 2 lessons dropped');
  });

  it('says a run found nothing rather than leaving the row blank', () => {
    expect(
      backgroundJobResult(
        backgroundJob({ lessons: { saved: 0, waiting: 0, dropped: 0 } }),
      ),
    ).toBe('No lessons found');
  });

  it('says why a run failed', () => {
    expect(
      backgroundJobResult(
        backgroundJob({
          status: 'failed',
          error: "You've hit your weekly limit",
          lessons: null,
        }),
      ),
    ).toBe("You've hit your weekly limit");
    expect(
      backgroundJobResult(
        backgroundJob({ status: 'failed', error: null, lessons: null }),
      ),
    ).toBe('Failed');
  });

  it('says what a running run is doing, and that a queued one waits', () => {
    expect(
      backgroundJobResult(
        backgroundJob({
          status: 'running',
          phase: 'reflecting',
          lessons: null,
        }),
      ),
    ).toBe('Reading the thread…');
    expect(
      backgroundJobResult(
        backgroundJob({ status: 'running', phase: 'checking', lessons: null }),
      ),
    ).toBe('Checking the lessons it found…');
    expect(
      backgroundJobResult(backgroundJob({ status: 'queued', lessons: null })),
    ).toBe('Waiting to start');
  });
});

describe('backgroundJobMeta', () => {
  it('reads cost, time and when it ended', () => {
    expect(backgroundJobMeta(backgroundJob(), JOBS_NOW)).toBe(
      '$0.28 · 34s · 9m ago',
    );
  });

  it('leaves out a figure nothing reported, never writing $0', () => {
    const meta = backgroundJobMeta(
      backgroundJob({ costUsd: null, durationMs: null }),
      JOBS_NOW,
    );

    expect(meta).toBe('9m ago');
  });
});

describe('backgroundJobThread and backgroundJobWaitsForReview', () => {
  it('names a thread with no title and offers review only when lessons wait', () => {
    expect(backgroundJobThread(backgroundJob({ title: null }))).toBe(
      'Untitled thread',
    );
    expect(backgroundJobWaitsForReview(backgroundJob())).toBe(true);
    expect(
      backgroundJobWaitsForReview(
        backgroundJob({ lessons: { saved: 1, waiting: 0, dropped: 0 } }),
      ),
    ).toBe(false);
  });
});
