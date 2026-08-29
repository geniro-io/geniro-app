// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ComparisonCard } from './comparison-block';
import type { ComparisonSpec } from './comparison-payload';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const SPEC: ComparisonSpec = {
  title: 'Local store for the daemon',
  options: [
    { name: 'SQLite', note: 'embedded, one file' },
    { name: 'Postgres', note: null },
  ],
  criteria: [
    {
      label: 'Setup cost',
      cells: [
        { value: 'none — a file', verdict: 'good' },
        { value: 'a server to run', verdict: 'bad' },
      ],
    },
    {
      label: 'Concurrency',
      cells: [
        { value: 'one writer', verdict: 'bad' },
        { value: 'many', verdict: 'good' },
      ],
    },
    {
      label: 'Wire format',
      cells: [
        { value: '', verdict: 'neutral' },
        { value: 'the same', verdict: 'neutral' },
      ],
    },
  ],
  recommendation: {
    option: 'SQLite',
    reason: 'the daemon is single-writer and local-first by rule',
  },
  recommendedIndex: 0,
};

const cells = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[data-slot="comparison-cell"]'),
];

describe('ComparisonCard', () => {
  it('draws options as columns and criteria as rows', () => {
    const el = render(<ComparisonCard comparison={SPEC} />);
    expect(el.querySelectorAll('[data-slot="comparison-option"]')).toHaveLength(
      2,
    );
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(cells(el)).toHaveLength(6);
    const text = el.textContent ?? '';
    for (const shown of [
      'Local store for the daemon',
      'SQLite',
      'embedded, one file',
      'Postgres',
      'Setup cost',
      'none — a file',
      'Concurrency',
      'many',
    ]) {
      expect(text).toContain(shown);
    }
  });

  it('TINTS the cell by its verdict — the reason this beats a table', () => {
    // The whole point is that the winning column looks greener from a metre
    // away, so the colour is on the cell rather than on a glyph inside it.
    const el = render(<ComparisonCard comparison={SPEC} />);
    const painted = cells(el);
    expect(painted[0]?.getAttribute('data-verdict')).toBe('good');
    expect(painted[0]?.className).toContain('bg-success/10');
    expect(painted[1]?.getAttribute('data-verdict')).toBe('bad');
    expect(painted[1]?.className).toContain('bg-destructive/10');
    // Neutral is UNtinted, not grey-tinted: a wash over every cell would
    // destroy the contrast the two verdicts are carrying.
    expect(painted[4]?.className).not.toContain('bg-');
  });

  it('marks the recommended column AND states its reason', () => {
    // Only the head would leave a verdict with no argument; only the foot
    // would leave the reader matching a name back to a column.
    const el = render(<ComparisonCard comparison={SPEC} />);
    const heads = [...el.querySelectorAll('[data-slot="comparison-option"]')];
    expect(heads[0]?.getAttribute('data-recommended')).toBe('true');
    expect(heads[1]?.getAttribute('data-recommended')).toBe('false');
    expect(
      el.querySelector('[data-slot="comparison-recommendation"]')?.textContent,
    ).toContain('single-writer');
  });

  it('marks NO column when the recommendation names none', () => {
    const el = render(
      <ComparisonCard
        comparison={{
          ...SPEC,
          recommendation: { option: 'DuckDB', reason: 'neither, actually' },
          recommendedIndex: null,
        }}
      />,
    );
    for (const head of el.querySelectorAll('[data-slot="comparison-option"]')) {
      expect(head.getAttribute('data-recommended')).toBe('false');
    }
    // …and the reason still reads, which is why a miss costs only the mark.
    expect(el.textContent).toContain('neither, actually');
  });

  it('draws an empty cell as a dash, not as a blank', () => {
    // A blank looks like a rendering failure; a dash says "nothing here",
    // which is what the daemon's blank means.
    const el = render(<ComparisonCard comparison={SPEC} />);
    expect(cells(el)[4]?.textContent).toBe('—');
  });

  it('omits the answer line entirely when there is no recommendation', () => {
    const el = render(
      <ComparisonCard
        comparison={{ ...SPEC, recommendation: null, recommendedIndex: null }}
      />,
    );
    expect(
      el.querySelector('[data-slot="comparison-recommendation"]'),
    ).toBeNull();
  });

  it('scrolls WIDE content inside its own container', () => {
    // The repo rule: a wide table must never make the page scroll sideways.
    const el = render(<ComparisonCard comparison={SPEC} />);
    expect(el.querySelector('.overflow-x-auto')).toBeTruthy();
  });
});
