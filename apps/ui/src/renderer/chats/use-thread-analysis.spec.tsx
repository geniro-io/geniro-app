// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient, RunStatusEvent } from '../daemon-client';
import {
  isAnalysisRun,
  type ThreadAnalysisMark,
  useThreadAnalysis,
} from './use-thread-analysis';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
});

function harness(analysis: unknown) {
  const listeners = new Set<(event: RunStatusEvent) => void>();
  const client = {
    onRunStatus: (listener: (event: RunStatusEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DaemonClient;
  const getThreadAnalysis = vi.fn(async () => ({ analysis }));
  const chatApi = { getThreadAnalysis } as unknown as DaemonApis['chats'];
  let mark: ThreadAnalysisMark = 'none';
  function Probe({
    source,
    refreshKey,
  }: {
    source: string | null;
    refreshKey: number;
  }): null {
    mark = useThreadAnalysis({
      chatApi,
      client,
      sourceRunId: source,
      refreshKey,
    });
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  return {
    getThreadAnalysis,
    mark: () => mark,
    render: async (source: string | null, refreshKey = 0) => {
      await act(async () => {
        root!.render(<Probe source={source} refreshKey={refreshKey} />);
      });
    },
    announce: async (event: Partial<RunStatusEvent>) => {
      await act(async () => {
        for (const listener of listeners) {
          listener({
            runId: 'analysis-1',
            status: null,
            ...event,
          } as RunStatusEvent);
        }
      });
    },
  };
}

describe('useThreadAnalysis', () => {
  it('follows the analysis run’s own announces: working, waiting on you, idle', async () => {
    const h = harness({
      id: 'analysis-1',
      status: 'completed',
      awaiting: null,
    });
    await h.render('source');
    expect(h.mark()).toBe('idle');

    await h.announce({ status: 'running' });
    expect(h.mark()).toBe('working');

    await h.announce({ awaiting: { kind: 'approval' } as never });
    expect(h.mark()).toBe('waiting');

    // Absent asserts nothing; null clears.
    await h.announce({ status: 'completed' });
    expect(h.mark()).toBe('waiting');
    await h.announce({ awaiting: null });
    expect(h.mark()).toBe('idle');

    // Another run's announce is not this analysis's.
    await h.announce({ runId: 'r9', status: 'running' });
    expect(h.mark()).toBe('idle');
  });

  it('reads none for a thread with no analysis, and re-reads on a refresh', async () => {
    const h = harness(null);
    await h.render('source');
    expect(h.mark()).toBe('none');

    h.getThreadAnalysis.mockResolvedValueOnce({
      analysis: { id: 'analysis-1', status: 'running', awaiting: null },
    } as never);
    await h.render('source', 1);

    expect(h.getThreadAnalysis).toHaveBeenCalledTimes(2);
    expect(h.mark()).toBe('working');
  });

  it('marks none when the analysis cannot be read', async () => {
    const h = harness(null);
    h.getThreadAnalysis.mockRejectedValueOnce(new Error('daemon down'));

    await h.render('source');

    expect(h.getThreadAnalysis).toHaveBeenCalledTimes(1);
    expect(h.mark()).toBe('none');
  });

  it('marks nothing for no thread, and never one thread’s analysis on another', async () => {
    const h = harness({ id: 'analysis-1', status: 'running', awaiting: null });
    await h.render(null);
    expect(h.mark()).toBe('none');
    expect(h.getThreadAnalysis).not.toHaveBeenCalled();

    await h.render('source');
    expect(h.mark()).toBe('working');
    h.getThreadAnalysis.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    await h.render('other');
    expect(h.mark()).toBe('none');
  });
});

describe('isAnalysisRun', () => {
  it('tells a thread’s or a workflow’s analysis from any other run', () => {
    const none = { analysisSourceRunId: null, analysisWorkflowSlug: null };

    expect(isAnalysisRun(none)).toBe(false);
    expect(isAnalysisRun({ ...none, analysisSourceRunId: 'src' })).toBe(true);
    expect(isAnalysisRun({ ...none, analysisWorkflowSlug: 'team' })).toBe(true);
  });
});
