// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FindingsCard } from './findings-block';
import type { FindingRow, FindingsReport } from './findings-payload';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const row = (overrides: Partial<FindingRow> = {}): FindingRow => ({
  file: 'src/a.ts',
  line: null,
  summary: 'A guard was weakened',
  shortSummary: null,
  failureScenario: null,
  category: null,
  verdict: null,
  outcome: null,
  ...overrides,
});

function draw(report: FindingsReport): void {
  act(() => root.render(<FindingsCard report={report} />));
}

function findingRows(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-slot="finding-row"]'),
  ];
}

/** The first finding row's own disclosure button. */
function toggleOf(at: number): HTMLButtonElement {
  const button = findingRows()[at]?.querySelector('button');
  if (!button) {
    throw new Error(`no finding row at ${at}`);
  }
  return button;
}

describe('FindingsCard', () => {
  it('heads the card with the level and the count', () => {
    draw({ level: 'high', findings: [row(), row({ file: 'src/b.ts' })] });
    expect(container.textContent).toContain('Code review · high · 2 findings');
  });

  it('says one finding in the singular, and omits a level nobody gave', () => {
    draw({ level: null, findings: [row()] });
    expect(container.textContent).toContain('Code review · 1 finding');
    expect(container.textContent).not.toContain('· null');
  });

  it('says an empty report finished with nothing, rather than drawing a blank card', () => {
    draw({ level: 'low', findings: [] });
    expect(container.textContent).toContain('Code review · low · no findings');
    expect(container.textContent).toContain(
      'The review finished with nothing to report.',
    );
    expect(findingRows()).toHaveLength(0);
  });

  it('groups rows under their file, in the order the agent sent them', () => {
    draw({
      level: null,
      findings: [
        row({ file: 'src/b.ts', summary: 'first' }),
        row({ file: 'src/a.ts', summary: 'second' }),
        row({ file: 'src/b.ts', summary: 'third' }),
      ],
    });
    const headings = [
      ...container.querySelectorAll('[data-slot="finding-file"]'),
    ].map((node) => node.textContent);
    expect(headings).toEqual(['src/b.ts', 'src/a.ts']);
    expect(findingRows()).toHaveLength(3);
  });

  it('opens with the report showing — it is the answer, not a line to press', () => {
    draw({ level: null, findings: [row()] });
    expect(
      container
        .querySelector('[data-slot="findings-card"]')
        ?.getAttribute('data-open'),
    ).toBe('true');
    expect(findingRows()).toHaveLength(1);
  });

  it('collapses the whole card away when its header is pressed', () => {
    draw({ level: null, findings: [row()] });
    const header = container.querySelector<HTMLButtonElement>(
      '[data-slot="findings-card"] > * > button',
    );
    act(() => header?.click());
    expect(findingRows()).toHaveLength(0);
  });

  it('shows the short label collapsed and the full sentence expanded', () => {
    draw({
      level: null,
      findings: [
        row({
          shortSummary: 'CAS guard weakened',
          summary: 'finalizeCompleted no longer checks generation',
          failureScenario: 'A superseded worker wins the write.',
        }),
      ],
    });
    expect(container.textContent).toContain('CAS guard weakened');
    // The long half is the whole reason the row is a disclosure.
    expect(container.textContent).not.toContain(
      'A superseded worker wins the write.',
    );

    act(() => toggleOf(0).click());

    expect(container.textContent).toContain(
      'finalizeCompleted no longer checks generation',
    );
    expect(container.textContent).toContain(
      'A superseded worker wins the write.',
    );
    expect(container.textContent).toContain('How it fails');
  });

  it('falls back to the full sentence when the agent wrote no short label', () => {
    draw({ level: null, findings: [row({ shortSummary: null })] });
    expect(container.textContent).toContain('A guard was weakened');
  });

  it('badges a verdict, and says nothing where a verification never ran', () => {
    draw({
      level: null,
      findings: [
        row({ verdict: 'CONFIRMED' }),
        row({ verdict: 'PLAUSIBLE' }),
        row({ verdict: null }),
      ],
    });
    expect(container.textContent).toContain('Confirmed');
    expect(container.textContent).toContain('Plausible');
    expect(
      findingRows().map((node) => node.getAttribute('data-verdict')),
    ).toEqual(['CONFIRMED', 'PLAUSIBLE', 'none']);
    // The header segment earns its place only where it says something the
    // count does not — here 1 of 3.
    expect(container.textContent).toContain('· 1 confirmed');
  });

  it('drops the confirmed tally when every finding carries it', () => {
    draw({
      level: null,
      findings: [row({ verdict: 'CONFIRMED' }), row({ verdict: 'CONFIRMED' })],
    });
    expect(container.textContent).toContain('2 findings');
    expect(container.textContent).not.toContain('confirmed');
  });

  it('badges an outcome, which is what a re-report after fixes carries', () => {
    draw({
      level: null,
      findings: [
        row({ outcome: 'fixed' }),
        row({ outcome: 'no_change_needed' }),
      ],
    });
    expect(container.textContent).toContain('Fixed');
    expect(container.textContent).toContain('No change needed');
    expect(container.textContent).toContain('· 2 resolved');
  });

  it('shows file, line and category together once a row is opened', () => {
    draw({
      level: null,
      findings: [row({ line: 402, category: 'correctness' })],
    });
    act(() => toggleOf(0).click());
    expect(container.textContent).toContain('src/a.ts:402 · correctness');
  });

  it('omits a line nobody gave rather than printing a placeholder', () => {
    draw({ level: null, findings: [row({ line: null })] });
    act(() => toggleOf(0).click());
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).not.toContain('src/a.ts:');
  });

  it('opens one row without opening its neighbour', () => {
    draw({
      level: null,
      findings: [
        row({ summary: 'the first defect' }),
        row({ summary: 'the second defect' }),
      ],
    });
    act(() => toggleOf(0).click());
    expect(findingRows().map((node) => node.getAttribute('data-open'))).toEqual(
      ['true', 'false'],
    );
  });
});
