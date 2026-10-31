// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HOTSPOTS,
  ITEMS,
  LOOK,
  recommendation,
  TIMING,
  WORKFLOW_STATS,
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

function projection(el: HTMLElement): string {
  return (
    el.querySelector('[data-slot="analysis-projection"]')?.textContent ?? ''
  );
}

function projectionRows(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-slot="analysis-projection-row"]')].map(
    (row) => row.textContent ?? '',
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

    expect(footer(el)).toContain('2 of 4 selected');
    expect(projection(el)).toContain('with the 2 selected');
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

  it('says nothing was found worth changing when there is nothing to recommend', () => {
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
      'No recommendations — nothing was found worth changing.',
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

  it('draws memory items in a Memory group of their own, after the others', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflow={false}
        items={[
          recommendation('M-1'),
          recommendation('R-1'),
          recommendation('U-1'),
        ]}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );

    const headings = [...el.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings).toEqual([
      'Repository',
      'Your agent instructions',
      'Memory',
    ]);
    expect(
      el.querySelector('section:last-of-type [data-id="M-1"]'),
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

  it("projects the runs' time and cost with what is ticked, and with every item while nothing is", () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );

    expect(projection(el)).toContain('with all 4');
    expect(projectionRows(el)).toEqual([
      expect.stringContaining('42m→2m'),
      expect.stringContaining('$3.10→$1.85'),
    ]);

    click(button(el, 'W-1'));
    click(button(el, 'R-1'));

    expect(projection(el)).toContain('with the 2 selected');
    expect(projectionRows(el)).toEqual([
      expect.stringContaining('42m→12m−30m · −71%'),
      expect.stringContaining('$3.10→$2.70−$0.40 · −13%'),
    ]);
  });

  it('shows a change that adds time or money as a rise, never as a saving', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        workflow
        items={[
          recommendation('W-1', {
            minutesSaved: -4,
            costSavedUsd: -0.5,
            outcome: 'A QA pass catches the failures before review',
          }),
        ]}
        applied={null}
        outcomes={{}}
      />,
    );
    const row = el.querySelector('[data-id="W-1"]')!;

    expect(
      row.querySelector('[data-slot="recommendation-time"]')?.textContent,
    ).toBe('+4m/run');
    expect(
      row.querySelector('[data-slot="recommendation-cost"]')?.textContent,
    ).toBe('+$0.50/run');
    expect(
      row.querySelector('[data-slot="recommendation-expected"]')?.textContent,
    ).toBe('A QA pass catches the failures before review');
    expect(projectionRows(el)).toEqual([
      expect.stringContaining('42m→46m+4m · +10%'),
      expect.stringContaining('$3.10→$3.60+$0.50 · +16%'),
    ]);
  });

  it("draws the runs' measured figures: a scorecard, each agent's share of the working time, and models, runs and calls in folds", () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );
    const tiles = [...el.querySelectorAll('[data-slot="analysis-tile"]')].map(
      (tile) => tile.textContent,
    );
    const agents = [...el.querySelectorAll('[data-slot="analysis-agent"]')];

    expect(el.textContent).toContain('Workflow analysis · 8 runs');
    expect(tiles).toEqual([
      expect.stringContaining('Time per run42maverage of 8 runs'),
      expect.stringContaining('Cost per run$3.10$24.80 in all'),
      expect.stringContaining('Failed turns7of 196 turns'),
      expect.stringContaining('Waiting on you6m'),
    ]);
    expect(agents.map((agent) => agent.getAttribute('data-node'))).toEqual([
      'reviewer',
      'builder',
      'qa',
      'lead',
    ]);
    expect(agents[0]!.textContent).toContain('opus34m/run53%$1.80/run');
    expect(agents[3]!.textContent).toContain('29m blocked on callees');
    expect(el.querySelector('[data-slot="analysis-models"]')).toBeNull();

    click(button(el, 'Models'));
    click(button(el, 'Runs'));
    click(button(el, 'Calls between agents'));

    expect(
      el.querySelector('[data-slot="analysis-models"]')?.textContent,
    ).toContain('gpt-5.5-codex');
    expect(el.querySelectorAll('[data-slot="analysis-runs"] li')).toHaveLength(
      8,
    );
    expect(
      el.querySelector('[data-slot="analysis-calls"]')?.textContent,
    ).toContain('lead → reviewer');
    expect(
      [...el.querySelectorAll('[data-slot="analysis-call-worked"]')].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(['3h 10m', '2h 30m', '—']);
    expect(el.textContent).toContain('Calls between agents · 3');
  });

  it('explains each hotspot with the figures of the agent it names, and ticks its fix from there', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        hotspots={HOTSPOTS}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );
    const hotspots = [...el.querySelectorAll('[data-slot="analysis-hotspot"]')];
    const fix = hotspots[1]!.querySelector<HTMLButtonElement>(
      '[data-slot="analysis-hotspot-fix"]',
    )!;

    expect(hotspots).toHaveLength(2);
    expect(
      hotspots[0]!.querySelector('[data-slot="analysis-hotspot-figures"]')
        ?.textContent,
    ).toBe('reviewer34m/run53% of the agents’ time$1.80/run3 failed turns');
    expect(hotspots[0]!.textContent).toContain('The lead waits for reviewer-a');
    expect(fix.textContent).toBe('W-2');

    click(fix);

    expect(fix.getAttribute('aria-pressed')).toBe('true');
    expect(
      el
        .querySelector('[data-id="W-2"] button[aria-pressed]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(footer(el)).toContain('1 of 4 selected');
  });

  it("projects a plain chat's wall time from its timing, and a saving with no measured cost as a bare change", () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        workflow={false}
        items={[recommendation('R-1', { costSavedUsd: 0.3 })]}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(projectionRows(el)).toEqual([
      expect.stringContaining('3h 0m→2h 52m'),
    ]);
    expect(projection(el)).toContain('−$0.30 per thread');
  });

  it('projects only what was applied, leaving out what failed or was skipped', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        workflow
        items={ITEMS}
        applied={['W-1', 'R-1', 'U-1']}
        outcomes={{
          'W-1': { status: 'applied', note: null, backup: null },
          'R-1': { status: 'failed', note: 'file moved', backup: null },
        }}
      />,
    );

    expect(projection(el)).toContain('with the 2 applied');
    expect(projectionRows(el)).toEqual([
      expect.stringContaining('42m→16m'),
      expect.stringContaining('$3.10→$2.70'),
    ]);
  });

  it('says when the calls fold lists only the longest edges', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={{ ...WORKFLOW_STATS, callEdges: 12 }}
        workflow
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(el.textContent).toContain('Calls between agents · longest 3 of 12');
  });

  it('never says nothing is worth changing beside the hotspots it shows', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        workflowStats={WORKFLOW_STATS}
        hotspots={[{ ...HOTSPOTS[0]!, items: [] }]}
        workflow
        items={[]}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(el.textContent).toContain('No recommendations on this card.');
    expect(el.textContent).not.toContain('nothing was found worth changing');
  });
});
