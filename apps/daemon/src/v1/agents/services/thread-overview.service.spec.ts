import { NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { threadOverviewQuerySchema } from '../dto/chat.dto';
import type { ChatArtifactsService } from './chat-artifacts.service';
import type { ChatMetricsService } from './chat-metrics.service';
import type { ChatTimelineService } from './chat-timeline.service';
import type { RunStateService } from './run-state.service';
import type { ThreadAnalysisService } from './thread-analysis.service';
import { ThreadOverviewService } from './thread-overview.service';

const STATE = { marker: 'state' };
const TOTALS = { marker: 'totals' };
const TIMELINE = { marker: 'timeline' };
const ARTIFACTS = { artifacts: [] };

function overview(
  overrides: {
    state?: () => Promise<unknown>;
    find?: () => Promise<unknown>;
  } = {},
) {
  const runState = { read: vi.fn(overrides.state ?? (async () => STATE)) };
  const metrics = { readTotalsResponse: vi.fn(async () => TOTALS) };
  const timeline = { read: vi.fn(async () => TIMELINE) };
  const artifacts = { read: vi.fn(async () => ARTIFACTS) };
  const analyses = { find: vi.fn(overrides.find ?? (async () => null)) };
  return {
    runState,
    metrics,
    timeline,
    artifacts,
    analyses,
    service: new ThreadOverviewService(
      runState as unknown as RunStateService,
      metrics as unknown as ChatMetricsService,
      timeline as unknown as ChatTimelineService,
      artifacts as unknown as ChatArtifactsService,
      analyses as unknown as ThreadAnalysisService,
    ),
  };
}

describe('ThreadOverviewService', () => {
  it('answers each part asked with its own route’s reading, and reads nothing else', async () => {
    const o = overview();

    const answer = await o.service.read('run-1', [
      'state',
      'totals',
      'analysis',
    ]);

    expect(o.runState.read).toHaveBeenCalledWith('run-1');
    expect(o.metrics.readTotalsResponse).toHaveBeenCalledWith('run-1');
    expect(o.analyses.find).toHaveBeenCalledWith('run-1');
    // Not asked, so not read — a re-read of one part costs one part.
    expect(o.timeline.read).not.toHaveBeenCalled();
    expect(o.artifacts.read).not.toHaveBeenCalled();
    expect(answer).toEqual({
      state: STATE,
      totals: TOTALS,
      timeline: null,
      artifacts: null,
      analysis: { analysis: null },
    });
  });

  it('answers null for the one part that failed and keeps the others', async () => {
    const o = overview({
      find: async () => {
        throw new Error('analysis lookup failed');
      },
    });

    const answer = await o.service.read('run-1', ['state', 'analysis']);

    expect(answer.state).toEqual(STATE);
    expect(answer.analysis).toBeNull();
  });

  it('throws when no part asked could be read — a missing thread stays a 404', async () => {
    const missing = new NotFoundException('RUN_NOT_FOUND');
    const o = overview({
      state: async () => {
        throw missing;
      },
      find: async () => {
        throw missing;
      },
    });

    await expect(o.service.read('gone', ['state', 'analysis'])).rejects.toBe(
      missing,
    );
  });
});

describe('the overview query', () => {
  it('reads a comma-separated list of parts', () => {
    expect(
      threadOverviewQuerySchema.parse({ parts: 'state,timeline' }),
    ).toEqual({
      parts: ['state', 'timeline'],
    });
  });

  it('refuses an unknown part rather than ignoring it', () => {
    expect(
      threadOverviewQuerySchema.safeParse({ parts: 'state,everything' })
        .success,
    ).toBe(false);
  });
});
