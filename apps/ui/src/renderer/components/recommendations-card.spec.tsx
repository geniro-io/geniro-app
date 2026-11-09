// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_ITEM,
  HOTSPOTS,
  ITEMS,
  LOOK,
  MEMBERS,
  recommendation,
  SAMPLED_TEAM_STATS,
  TEAM_POPULATION,
  TEAM_STATS,
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

function projection(el: HTMLElement): string {
  return (
    el.querySelector('[data-slot="analysis-projection"]')?.textContent ?? ''
  );
}

function populationLine(el: HTMLElement): string {
  return (
    el.querySelector('[data-slot="analysis-population"]')?.textContent ?? ''
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
        team
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

  describe('a move', () => {
    const MOVE = [
      { ...ITEMS[0]!, id: 'P-1', target: 'project' as const },
      {
        ...ITEMS[0]!,
        id: 'K-1',
        target: 'knowledge' as const,
        document: {
          place: 'project:p1',
          handle: null,
          title: 'Release checklist',
        },
        movesWith: 'P-1',
      },
      { ...ITEMS[0]!, id: 'R-9', target: 'repo' as const },
    ];
    const tick = (el: HTMLElement, id: string): HTMLButtonElement =>
      el.querySelector<HTMLButtonElement>(
        `[data-slot="recommendation-row"][data-id="${id}"] button[aria-pressed]`,
      )!;

    it.each([
      ['the document', 'K-1'],
      ['its source', 'P-1'],
    ])('ticks and unticks both sides from %s, and no other item', (_, id) => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          team={false}
          items={MOVE}
          applied={null}
          outcomes={{}}
          onApply={() => undefined}
        />,
      );
      const pressed = (name: string) =>
        tick(el, name).getAttribute('aria-pressed');

      act(() => tick(el, id).click());
      expect([pressed('K-1'), pressed('P-1'), pressed('R-9')]).toEqual([
        'true',
        'true',
        'false',
      ]);

      act(() => tick(el, id).click());
      expect([pressed('K-1'), pressed('P-1')]).toEqual(['false', 'false']);
    });

    it('applies both sides, and names on each row what it moves with', () => {
      const onApply = vi.fn();
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          team={false}
          items={MOVE}
          applied={null}
          outcomes={{}}
          onApply={onApply}
        />,
      );

      act(() => tick(el, 'K-1').click());
      click(button(el, 'Apply selected'));

      expect(onApply).toHaveBeenCalledWith(['K-1', 'P-1']);
      const moves = [
        ...el.querySelectorAll('[data-slot="recommendation-move"]'),
      ].map((badge) => badge.textContent);
      expect(moves).toEqual(['moves with K-1', 'moves with P-1']);
    });

    it('draws the knowledge group, naming the document where the location would stand', () => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          team={false}
          items={MOVE}
          applied={null}
          outcomes={{}}
          onApply={() => undefined}
          folds={{ isOpen: () => true, toggle: () => undefined }}
        />,
      );

      expect(el.textContent).toContain('Knowledge');
      expect(el.textContent).toContain('project:p1 · Release checklist');
    });
  });

  it('locks the checkboxes once an Apply is sent, and queues what has no outcome yet', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        team
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
        team
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
        team
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

  it('draws no Team group for a plain chat, and the user-instruction items in their own', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        team={false}
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
        team={false}
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

  it.each([
    ['a chat card', false],
    ['a team card', true],
  ])(
    'draws project items in a Project instructions group, after memory, on %s',
    (_name, team) => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          team={team}
          items={[
            recommendation('P-1'),
            recommendation('M-1'),
            recommendation('R-1'),
          ]}
          applied={null}
          outcomes={{}}
          onApply={vi.fn()}
        />,
      );

      const headings = [...el.querySelectorAll('h4')].map((h) => h.textContent);
      expect(headings).toEqual([
        'Repository',
        'Memory',
        'Project instructions',
      ]);
      expect(
        el.querySelector('section:last-of-type [data-id="P-1"]'),
      ).not.toBeNull();
    },
  );

  it('draws overlay items in a Project overlay group, after the project instructions', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        team
        items={[
          recommendation('O-1', {
            target: 'overlay',
            kind: 'member',
            location: 'p-billing',
          }),
          recommendation('P-1'),
          recommendation('W-1'),
        ]}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );

    const headings = [...el.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings).toEqual([
      'Team',
      'Project instructions',
      'Project overlay',
    ]);
    expect(
      el.querySelector('section:last-of-type [data-id="O-1"]'),
    ).not.toBeNull();
  });

  it('tags each row with its territory, and says what the territory means', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        team={false}
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
        team={false}
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
        team
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
        team
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
        teamStats={TEAM_STATS}
        team
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
        teamStats={TEAM_STATS}
        team
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
        teamStats={TEAM_STATS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );
    const tiles = [...el.querySelectorAll('[data-slot="analysis-tile"]')].map(
      (tile) => tile.textContent,
    );
    const agents = [...el.querySelectorAll('[data-slot="analysis-agent"]')];

    expect(el.textContent).toContain('Team analysis · 8 runs');
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
        teamStats={TEAM_STATS}
        hotspots={HOTSPOTS}
        team
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
        team={false}
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
        teamStats={TEAM_STATS}
        team
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
        teamStats={{ ...TEAM_STATS, callEdges: 12 }}
        team
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
        teamStats={TEAM_STATS}
        hotspots={[{ ...HOTSPOTS[0]!, items: [] }]}
        team
        items={[]}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(el.textContent).toContain('No recommendations on this card.');
    expect(el.textContent).not.toContain('nothing was found worth changing');
  });

  it("draws each member's marks and verdict beside its measured figures, ticks the items that carry a verdict out, and names who went unassessed", () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        teamStats={TEAM_STATS}
        hotspots={HOTSPOTS}
        members={MEMBERS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
        onApply={vi.fn()}
      />,
    );
    const rows = [
      ...el.querySelectorAll<HTMLElement>('[data-slot="analysis-member"]'),
    ];
    const reviewer = rows[0]!;
    const fix = reviewer.querySelector<HTMLButtonElement>(
      '[data-slot="analysis-member-fix"]',
    )!;

    expect(rows.map((row) => row.getAttribute('data-member'))).toEqual([
      'reviewer',
      'qa',
      'builder',
    ]);
    expect(
      [...reviewer.querySelectorAll('[data-slot="mark-meter"]')].map((meter) =>
        meter.getAttribute('aria-label'),
      ),
    ).toEqual(['Usefulness 4 of 5', 'Quality 3 of 5']);
    expect(
      reviewer
        .querySelector('[data-slot="member-verdict"]')
        ?.getAttribute('data-verdict'),
    ).toBe('tune');
    expect(
      reviewer.querySelector('[data-slot="analysis-hotspot-figures"]')
        ?.textContent,
    ).toBe('34m/run53% of the agents’ time$1.80/run3 failed turns');
    expect(
      rows[2]!.querySelector('[data-slot="analysis-member-fix"]'),
    ).toBeNull();
    expect(
      el.querySelector('[data-slot="analysis-members-unassessed"]')
        ?.textContent,
    ).toBe('Not assessed: lead');
    expect(reviewer.textContent).not.toContain('Reading the full diff again');

    click(fix);
    click(button(reviewer, 'Evidence'));

    expect(
      el
        .querySelector('[data-id="W-1"] button[aria-pressed]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(footer(el)).toContain('1 of 4 selected');
    expect(reviewer.textContent).toContain('Reading the full diff again');
  });

  it('draws no members section for a card that assessed none', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={TIMING}
        team={false}
        items={ITEMS.filter((item) => item.target !== 'team')}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(el.querySelector('[data-slot="analysis-members"]')).toBeNull();
  });

  it("takes the user's verdict on a member's marks when the card is given a setter, and draws none without one", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        teamStats={TEAM_STATS}
        members={MEMBERS}
        memberVerdicts={{
          verdicts: {
            qa: { verdict: 'disagree', note: 'it ran the wrong suite' },
          },
          onChange,
        }}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );
    const rows = [
      ...el.querySelectorAll<HTMLElement>('[data-slot="analysis-member"]'),
    ];

    expect(
      rows.map((row) =>
        row
          .querySelector('[data-slot="assessment-verdict"]')
          ?.getAttribute('data-verdict'),
      ),
    ).toEqual(['none', 'disagree', 'none']);
    expect(rows[1]!.textContent).toContain('it ran the wrong suite');

    await act(async () => {
      button(rows[0]!, 'Agree').click();
    });

    expect(onChange).toHaveBeenCalledWith('reviewer', {
      verdict: 'agree',
      note: null,
    });

    const bare = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        members={MEMBERS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );
    expect(bare.querySelector('[data-slot="assessment-verdict"]')).toBeNull();
  });

  it('draws the runs the figures read against every run the team has, and the per-run figures over all of them', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        teamStats={SAMPLED_TEAM_STATS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(populationLine(el)).toBe(
      'Read 8 of 216 runs. Over all 216: $4.60 per run · 58m worked · 27 turns',
    );
  });

  it.each([
    [8, 'Read all 8 runs'],
    [1, 'Read the only run'],
  ])(
    'reads a population the runs read already cover as those runs, with no averages (%i run)',
    (runs, line) => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          teamStats={{
            ...SAMPLED_TEAM_STATS,
            runs,
            population: { ...TEAM_POPULATION, runs },
          }}
          team
          items={ITEMS}
          applied={null}
          outcomes={{}}
        />,
      );

      expect(populationLine(el)).toBe(line);
    },
  );

  it.each([
    [
      'no run priced',
      { costUsd: null, pricedRuns: 216 },
      'Read 8 of 216 runs. Over all 216: 58m worked · 27 turns',
    ],
    [
      'some runs unpriced',
      { costUsd: 4.6, pricedRuns: 200 },
      'Read 8 of 216 runs. Over all 216: $4.60 (200 priced) per run · 58m worked · 27 turns',
    ],
    [
      'no worked time measured',
      { workedMs: null },
      'Read 8 of 216 runs. Over all 216: $4.60 per run · 27 turns',
    ],
  ])(
    'drops a figure nothing measured, and names the priced runs when some were not (%s)',
    (_, perRun, line) => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          teamStats={{
            ...SAMPLED_TEAM_STATS,
            population: {
              ...TEAM_POPULATION,
              perRun: { ...TEAM_POPULATION.perRun, ...perRun },
            },
          }}
          team
          items={ITEMS}
          applied={null}
          outcomes={{}}
        />,
      );

      expect(populationLine(el)).toBe(line);
    },
  );

  it('draws no population line for a card whose figures carry none', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        teamStats={TEAM_STATS}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(el.querySelector('[data-slot="analysis-population"]')).toBeNull();
    expect(el.querySelectorAll('[data-slot="analysis-tile"]')).toHaveLength(4);
  });

  it.each([
    [
      'with a cost',
      TEAM_POPULATION,
      'Measured over the 8 runs read; over all 216 a run costs $4.60.',
    ],
    [
      'without one',
      {
        ...TEAM_POPULATION,
        perRun: { ...TEAM_POPULATION.perRun, costUsd: null },
      },
      'Measured over the 8 runs read of 216.',
    ],
  ])(
    'names the runs its projection measured against the population when it is larger (%s)',
    (_, population, sentence) => {
      const el = render(
        <RecommendationsCard
          look={LOOK}
          summary={null}
          timing={null}
          teamStats={{ ...TEAM_STATS, population }}
          team
          items={ITEMS}
          applied={null}
          outcomes={{}}
        />,
      );

      expect(projection(el)).toContain(sentence);
      expect(projection(el)).toContain('items can overlap');
    },
  );

  it('leaves the projection to the runs it measured when the population is no larger', () => {
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        teamStats={{
          ...TEAM_STATS,
          population: { ...TEAM_POPULATION, runs: 8 },
        }}
        team
        items={ITEMS}
        applied={null}
        outcomes={{}}
      />,
    );

    expect(projection(el)).not.toContain('Measured over');
  });

  it('draws an external item under Other repositories, last, and ticks and applies it like any other', () => {
    const onApply = vi.fn();
    const el = render(
      <RecommendationsCard
        look={LOOK}
        summary={null}
        timing={null}
        team
        items={[...ITEMS, EXTERNAL_ITEM]}
        applied={null}
        outcomes={{}}
        onApply={onApply}
      />,
    );
    const headings = [...el.querySelectorAll('h4')].map((h) => h.textContent);
    const row = el.querySelector<HTMLElement>(
      '[data-slot="recommendation-row"][data-id="X-1"]',
    )!;

    expect(headings).toEqual([
      'Team',
      'Repository',
      'Your agent instructions',
      'Other repositories',
    ]);
    click(
      [...row.querySelectorAll('button')].find(
        (b) => b.textContent === 'Change',
      )!,
    );
    expect(row.textContent).toContain('/Users/dev/Projects/billing-service');

    click(button(el, 'X-1'));
    expect(footer(el)).toContain('1 of 5 selected');
    click(button(el, 'Apply selected'));
    expect(onApply).toHaveBeenCalledWith(['X-1']);
  });
});
