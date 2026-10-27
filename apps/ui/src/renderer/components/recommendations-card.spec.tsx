// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ITEMS,
  LOOK,
  recommendation,
  TIMING,
} from '../__fixtures__/recommendations';
import { RecommendationsCard } from './recommendations-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function button(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (b) =>
      b.textContent?.includes(name) ||
      b.getAttribute('aria-label')?.startsWith(name),
  );
  if (!found) {
    throw new Error(`no button "${name}"`);
  }
  return found as HTMLButtonElement;
}

function click(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

function footer(el: HTMLElement): string {
  return (
    el.querySelector('[data-slot="recommendations-footer"]')?.textContent ?? ''
  );
}

describe('RecommendationsCard', () => {
  it('counts the selection and its savings live, and applies only what was ticked', () => {
    const onApply = vi.fn();
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={onApply}
      />,
    );
    expect(footer(el)).toContain('0 of 4 selected');
    expect(button(el, 'Apply selected').disabled).toBe(true);

    click(button(el, 'W-1'));
    click(button(el, 'R-1'));

    expect(footer(el)).toContain('2 of 4 selected · ≈ 30 min/run saved');
    click(button(el, 'Apply selected'));
    expect(onApply).toHaveBeenCalledWith(['W-1', 'R-1']);
  });

  it('locks the checkboxes once an Apply is sent, and queues what has no outcome yet', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow
        items={ITEMS}
        applied={['W-1', 'R-1']}
        outcomes={{
          'W-1': { status: 'applied', note: null, backup: '.backups/x.yaml' },
        }}
        onApply={vi.fn()}
      />,
    );
    const card = el.querySelector('[data-slot="recommendations-card"]')!;
    expect(card.getAttribute('data-state')).toBe('applying');
    expect(button(el, 'W-2').disabled).toBe(true);
    expect(el.querySelector('[data-slot="recommendations-footer"]')).toBeNull();
    const outcome = (id: string): string =>
      el.querySelector(`[data-id="${id}"] [data-slot="recommendation-outcome"]`)
        ?.textContent ?? '';
    expect(outcome('W-1')).toBe('Applied');
    expect(outcome('R-1')).toBe('Queued');
    expect(el.textContent).toContain('backup: .backups/x.yaml');
  });

  it('shows each outcome and its reason once every selected item has one', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflow
        items={ITEMS}
        applied={['W-1', 'R-1']}
        outcomes={{
          'W-1': { status: 'skipped', note: 'already parallel', backup: null },
          'R-1': { status: 'failed', note: 'file moved', backup: null },
        }}
      />,
    );
    expect(
      el
        .querySelector('[data-slot="recommendations-card"]')!
        .getAttribute('data-state'),
    ).toBe('applied');
    const outcome = (id: string): string =>
      el.querySelector(`[data-id="${id}"] [data-slot="recommendation-outcome"]`)
        ?.textContent ?? '';
    expect(outcome('W-1')).toBe('Skipped');
    expect(outcome('R-1')).toBe('Failed');
    expect(el.textContent).toContain('already parallel');
    expect(el.textContent).toContain('file moved');
  });

  it('says the thread ran efficiently when there is nothing to recommend', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow
        items={[]}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );
    expect(el.textContent).toContain(
      'No recommendations — this thread ran efficiently.',
    );
    expect(el.querySelector('[data-slot="recommendations-footer"]')).toBeNull();
  });

  it('draws no Workflow group for a plain chat, and the user-instruction items in their own', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflow={false}
        items={[
          recommendation('U-1'),
          recommendation('R-1'),
          recommendation('W-9'),
        ]}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );
    const headings = [...el.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings).toEqual(['Repository', 'Your agent instructions']);
    expect(el.querySelector('[data-id="W-9"]')).toBeNull();
    expect(
      el.querySelector('section:last-of-type [data-id="U-1"]'),
    ).not.toBeNull();
  });

  it('tags each row with its territory, and says what the territory means', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflow={false}
        items={[
          recommendation('R-1', { territory: 'process' }),
          recommendation('R-2', { territory: 'domain' }),
        ]}
        applied={null}
        outcomes={{}}
      />,
    );
    const tag = (id: string): HTMLElement | null =>
      el.querySelector(
        `[data-id="${id}"] [data-slot="recommendation-territory"]`,
      );

    expect(tag('R-1')?.textContent).toBe('process');
    expect(tag('R-1')?.title).toContain('How the agents work');
    expect(tag('R-2')?.textContent).toBe('domain');
    expect(tag('R-2')?.title).toContain('What the work itself needs to know');
  });

  it('closes the estimate once, whether or not the agent ended it with a period', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow={false}
        items={[
          recommendation('R-1', { basis: 'one turn saved.', riskNote: 'x' }),
          recommendation('R-2', { basis: 'one call saved', riskNote: 'y' }),
          recommendation('R-3', {
            basis: 'a whole pass saved! ',
            riskNote: 'z',
          }),
        ]}
        applied={null}
        outcomes={{}}
      />,
    );
    for (const why of [...el.querySelectorAll('button')].filter(
      (b) => b.textContent === 'Why',
    )) {
      click(why);
    }

    expect(el.textContent).toContain('Estimate: one turn saved. If wrong: x');
    expect(el.textContent).toContain('Estimate: one call saved. If wrong: y');
    expect(el.textContent).toContain(
      'Estimate: a whole pass saved! If wrong: z',
    );
  });

  it('names the run a quote is from when the analysis read several', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflow
        items={[
          recommendation('W-1', {
            evidence: [
              {
                runId: '0f3c9a2e-1111-2222-3333-444455556666',
                seq: 12,
                ts: null,
                nodeId: 'reviewer',
                quote: 'again',
              },
              { seq: 4, ts: null, nodeId: null, quote: 'newest' },
            ],
          }),
        ]}
        applied={null}
        outcomes={{}}
      />,
    );
    click(button(el, 'Why'));

    expect(el.textContent).toContain('run 0f3c9a2e · seq 12 · reviewer');
    expect(el.textContent).toContain('seq 4newest');
  });

  it('names the critical path sinks in text beside the bar', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );
    const bar = el.querySelector('[role="img"]')!;
    expect(bar.getAttribute('aria-label')).toContain('reviewer 1h 10m');
    expect(el.textContent).toContain('Critical path');
  });
});
