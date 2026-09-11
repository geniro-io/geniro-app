// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { EntryCard } from './entry-card';
import type { CardEntry } from './transcript-groups';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The chart arm mounts recharts, which observes its container; jsdom ships no
// ResizeObserver and the card throws on mount without one.
stubResizeObserver();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The fields every card entry shares; each case adds its own payload. */
const base = {
  id: 'e1',
  createdAt: '2026-09-11T10:00:00.000Z',
  seq: 1,
  nodeId: null,
  parentToolUseId: null,
} as const;

function draw(entry: CardEntry): string {
  act(() => root.render(<EntryCard entry={entry} />));
  return container.textContent ?? '';
}

/**
 * ONE case per arm, asserting a word only that arm's payload can produce.
 *
 * The failure a test has to cover here: a missing arm renders NOTHING rather
 * than throwing, so a suite goes on passing with a card silently absent.
 */
describe('EntryCard', () => {
  it('draws a task list', () => {
    expect(
      draw({
        ...base,
        type: 'task-list',
        tasks: [
          {
            id: 't1',
            title: 'Sweep the sibling paths',
            status: 'in_progress',
            activeForm: null,
          },
        ],
        latest: true,
      }),
    ).toContain('Sweep the sibling paths');
  });

  it('draws a findings report', () => {
    expect(
      draw({
        ...base,
        type: 'findings',
        report: {
          level: null,
          findings: [
            {
              file: 'src/a.ts',
              line: null,
              summary: 'A guard was weakened',
              shortSummary: null,
              failureScenario: null,
              category: null,
              verdict: null,
              outcome: null,
            },
          ],
        },
      }),
    ).toContain('src/a.ts');
  });

  it('draws a chart', () => {
    expect(
      draw({
        ...base,
        type: 'chart',
        chart: {
          title: 'Test suite duration',
          kind: 'line',
          labels: ['a', 'b'],
          series: [{ name: 'unit', values: [1, 2] }],
          xLabel: null,
          yLabel: null,
        },
      }),
    ).toContain('Test suite duration');
  });

  it('draws a scorecard', () => {
    expect(
      draw({
        ...base,
        type: 'metrics',
        metrics: {
          title: 'After the sweep',
          metrics: [
            {
              label: 'Coverage',
              value: '82%',
              delta: null,
              sentiment: 'neutral',
              note: null,
            },
          ],
        },
      }),
    ).toContain('Coverage');
  });

  it('draws a comparison', () => {
    expect(
      draw({
        ...base,
        type: 'comparison',
        comparison: {
          title: 'Where to put the stamp',
          options: [
            { name: 'At the seam', note: null },
            { name: 'At the call sites', note: null },
          ],
          criteria: [
            {
              label: 'Reaches every writer',
              cells: [
                { value: 'yes', verdict: 'good' },
                { value: 'no', verdict: 'bad' },
              ],
            },
          ],
          recommendation: null,
          recommendedIndex: null,
        },
      }),
    ).toContain('Where to put the stamp');
  });

  it('draws a gallery', () => {
    expect(
      draw({
        ...base,
        type: 'gallery',
        gallery: {
          title: 'Before and after',
          images: [{ path: '/tmp/a.png', caption: 'the before' }],
        },
      }),
    ).toContain('Before and after');
  });

  it('draws a workflow card', () => {
    expect(
      draw({
        ...base,
        type: 'workflow',
        workflow: {
          id: 'wf1',
          name: 'review-changes',
          title: null,
          activity: null,
          tokens: null,
          toolUses: null,
          durationMs: null,
          agents: null,
        },
        script: null,
        returned: false,
        failed: false,
        result: null,
        resultIsOwn: false,
        lastRowAt: null,
      }),
    ).toContain('review-changes');
  });
});
