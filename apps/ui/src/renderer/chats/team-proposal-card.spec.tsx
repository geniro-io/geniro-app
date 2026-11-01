// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECORDED_NEW_PROPOSAL as LEGACY_NEW_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL as LEGACY_REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/team-proposals';
import { settleStageGraphs } from '../__tests__/settle-stage-graphs';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import {
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
  STAGES_PROPOSAL,
} from './__fixtures__/member-team-proposals';
import { ApprovalCard } from './approval-card';
import { PROPOSE_TEAM } from './geniro-tool';

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

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

afterEach(unmount);

const buttonNamed = (
  el: HTMLElement,
  text: string,
): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text);

const click = (node: HTMLElement): void => {
  act(() => {
    node.click();
  });
};

function typeInto(box: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const card = (
  props: Partial<React.ComponentProps<typeof ApprovalCard>> = {},
): React.ReactElement => (
  <ApprovalCard
    toolName={PROPOSE_TEAM}
    input={REPLACE_TO_AUTO_PROPOSAL}
    verdict={null}
    requestId="req-1"
    onRespond={vi.fn()}
    {...props}
  />
);

const proposalCard = (el: HTMLElement): HTMLElement | null =>
  el.querySelector('[data-slot="team-proposal-card"]');

const rosterRow = (el: HTMLElement, id: string): HTMLElement =>
  el.querySelector(`[data-agent="${id}"]`)!;

const openAgents = (el: HTMLElement): void => {
  const fold = el.querySelector<HTMLButtonElement>(
    '[data-slot="team-proposal-agents"] > button',
  )!;
  if (fold.getAttribute('aria-expanded') !== 'true') {
    click(fold);
  }
};

describe('TeamProposalCard', () => {
  it('draws the team card for a row recorded before the rename as propose_workflow', () => {
    const { team, diff, ...rest } = REPLACE_TO_AUTO_PROPOSAL as {
      team: unknown;
      diff: { teamFields: unknown };
    } & Record<string, unknown>;
    const { teamFields, ...ownDiff } = diff;
    const el = render(
      card({
        toolName: 'propose_workflow',
        input: {
          ...rest,
          workflow: team,
          diff: { ...ownDiff, workflowFields: teamFields },
        },
      }),
    );

    expect(proposalCard(el)).not.toBeNull();
  });

  it('draws a card raised while teams were node graphs as members', () => {
    const created = render(card({ input: LEGACY_NEW_PROPOSAL }));
    expect(proposalCard(created)).not.toBeNull();
    expect(created.textContent).toContain('2 members · first message to coder');
    unmount();

    const el = render(card({ input: LEGACY_REPLACE_TO_AUTO_PROPOSAL }));
    expect(el.textContent).toContain('3 members · first message to Coder');
    openAgents(el);
    expect(rosterRow(el, 'coder').textContent).toContain('Blocks: Style');
    expect(
      [...el.querySelectorAll('[data-slot="team-diff"] li')].map(
        (row) => row.textContent,
      )[0],
    ).toContain('tester added');
  });

  it('shows a member’s public role in its roster row and keeps its private instructions off the card', () => {
    const el = render(card());
    openAgents(el);
    const coder = rosterRow(el, 'coder').textContent;
    expect(coder).toContain('Writes the change');
    expect(coder).not.toContain('Implement the change the trigger describes');
  });

  it('names every auto agent in the strip and marks its roster row', () => {
    const el = render(card());
    const strip = el.querySelector('[data-slot="team-auto-strip"]');
    expect(strip?.getAttribute('role')).toBe('note');
    expect(strip?.textContent).toContain('2 agents run without asking');
    expect(strip?.textContent).toContain('Coder (coder)');
    expect(strip?.textContent).toContain('Tester (tester) — pool member 2');

    openAgents(el);
    expect(rosterRow(el, 'coder').textContent).toContain('Runs without asking');
    // The tester asks by its own setting; its second member does not.
    expect(rosterRow(el, 'tester').textContent).toContain(
      'member 2: Runs without asking',
    );
    expect(rosterRow(el, 'reviewer').textContent).not.toContain(
      'Runs without asking',
    );
  });

  it('draws no strip when every agent asks', () => {
    const el = render(card({ input: RECORDED_REPLACE_PROPOSAL }));
    expect(el.querySelector('[data-slot="team-auto-strip"]')).toBeNull();
  });

  it('lists approval → auto changes first in the diff', () => {
    const el = render(card());
    const rows = [
      ...el.querySelectorAll('[data-slot="team-diff"] li'),
    ] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.slice(0, 2).map((row) => row.dataset.toAuto)).toEqual([
      'true',
      'true',
    ]);
    expect(rows[0]!.textContent).toContain('tester added');
    expect(rows[1]!.textContent).toContain('coder · approval: ask → auto');
    expect(rows.slice(2).every((row) => row.dataset.toAuto === undefined)).toBe(
      true,
    );
  });

  it('says what a new team is, with no diff and no overwrite warning', () => {
    const el = render(card({ input: RECORDED_NEW_PROPOSAL }));
    expect(el.textContent).toContain('Review Pair');
    expect(el.textContent).toContain('New');
    expect(el.textContent).toContain('2 members · first message to Coder');
    expect(el.querySelector('[data-slot="team-diff"]')).toBeNull();
    expect(el.textContent).not.toContain('Approving overwrites');
  });

  it('says what the change does and why', () => {
    const el = render(card());
    expect(el.textContent).toContain(
      'Add a tester between the coder and the reviewer; the coder now runs without asking.',
    );
    expect(
      el.querySelector('[data-slot="team-proposal-reason"]')?.textContent,
    ).toBe(
      'Why: The user asked for tests before review.\nThe coder waited on every edit, so it now runs unattended.',
    );
  });

  it('draws no reason line for a proposal that gave none', () => {
    const el = render(card({ input: RECORDED_NEW_PROPOSAL }));
    expect(el.querySelector('[data-slot="team-proposal-reason"]')).toBeNull();
  });

  it('holds Approve over a hidden character in the reason', () => {
    const el = render(
      card({
        input: {
          ...(REPLACE_TO_AUTO_PROPOSAL as object),
          reason: 'Safe \u202Eetirw ton od\u202C',
        },
      }),
    );
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('warns a replacement overwrites the saved team, after a backup', () => {
    const el = render(card());
    expect(el.textContent).toContain('Replaces Review Pair');
    expect(el.textContent).toContain(
      'Approving overwrites Review Pair; the current file is backed up first.',
    );
  });

  it('sends the decline note as the verdict answer', () => {
    const onRespond = vi.fn();
    const el = render(card({ onRespond }));
    typeInto(
      el.querySelector('textarea[aria-label="Note to the agent"]')!,
      '  keep the coder asking  ',
    );
    click(buttonNamed(el, 'Decline')!);
    expect(onRespond).toHaveBeenCalledWith(false, 'keep the coder asking');
  });

  it('approves with no note as a plain one-argument verdict', () => {
    const onRespond = vi.fn();
    const el = render(card({ onRespond }));
    click(buttonNamed(el, 'Approve')!);
    expect(onRespond).toHaveBeenCalledWith(true);
    expect(onRespond.mock.calls[0]).toHaveLength(1);
    expect(el.textContent).toContain('Sending…');
  });

  it('holds Approve, never Decline, over a hidden character in what an agent wrote', () => {
    const input = REPLACE_TO_AUTO_PROPOSAL as {
      team: { members: Record<string, unknown>[] };
    };
    const tricked = {
      ...input,
      team: {
        ...input.team,
        members: input.team.members.map((member) =>
          member.id === 'reviewer'
            ? { ...member, instructions: 'Review \u202Eetirw ton od\u202C' }
            : member,
        ),
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+202E');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
    expect(buttonNamed(el, 'Decline')!.disabled).toBe(false);
  });

  it('holds Approve over a hidden character in a value the change list shows, old values included', () => {
    const input = RECORDED_REPLACE_PROPOSAL as {
      diff: {
        changedMembers: { id: string; fields: Record<string, string>[] }[];
      };
    };
    const tricked = {
      ...input,
      diff: {
        ...input.diff,
        changedMembers: [
          {
            id: 'reviewer',
            fields: [
              {
                field: 'instructions',
                before: '"Approve \u202Edneirf\u202C"',
                after: '"Review"',
              },
            ],
          },
        ],
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+202E');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('holds Approve over a control character in an old value the change list decodes', () => {
    const input = RECORDED_REPLACE_PROPOSAL as {
      diff: Record<string, unknown>;
    };
    const tricked = {
      ...input,
      diff: {
        ...input.diff,
        changedMembers: [
          {
            id: 'reviewer',
            fields: [
              {
                field: 'instructions',
                // As the daemon quotes it: the ESC is a `\u001b` escape here
                // and a real ESC once the list draws it.
                before: JSON.stringify('Old \u001b[2Jrole'),
                after: '"Review"',
              },
            ],
          },
        ],
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+001B');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('holds Approve over a control character JSON would have escaped', () => {
    const input = RECORDED_NEW_PROPOSAL as {
      team: { members: Record<string, unknown>[] };
    };
    const tricked = {
      ...input,
      team: {
        ...input.team,
        members: input.team.members.map((member) =>
          member.id === 'coder'
            ? { ...member, role: 'Code \u001b[2Jfast' }
            : member,
        ),
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+001B');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('does not gate a multi-line instruction block for its line breaks', () => {
    const input = REPLACE_TO_AUTO_PROPOSAL as {
      team: { instructionBlocks: Record<string, unknown>[] };
    };
    const multiline = {
      ...input,
      team: {
        ...input.team,
        instructionBlocks: input.team.instructionBlocks.map((block) =>
          block.id === 'style'
            ? { ...block, text: 'Line one.\nLine two.\tIndented.' }
            : block,
        ),
      },
    };
    const el = render(card({ input: multiline }));
    expect(el.querySelector('[data-slot="hazard-warning"]')).toBeNull();
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(false);
  });

  it('draws the stages a proposal walks and names each stage change', async () => {
    stubResizeObserver();
    const el = render(card({ input: STAGES_PROPOSAL }));
    await settleStageGraphs(el);
    expect(el.textContent).toContain(
      '2 members · first message to Coder · 3 stages',
    );
    const stages = el.querySelector('[data-slot="team-proposal-stages"]');
    expect(
      stages
        ?.querySelector('[data-slot="stage-graph-canvas"]')
        ?.getAttribute('aria-label'),
    ).toMatch(/Plan.*Build.*Review/);
    const rows = [...el.querySelectorAll('[data-slot="team-diff"] li')].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual([
      '+stage review added',
      '~stage build · next: ["ship"] → ["review"]',
      '−stage ship removed',
    ]);
  });

  it('shows every stage title and the text its agents read, on a new team too', () => {
    const replace = STAGES_PROPOSAL as {
      team: { stages: Record<string, unknown>[] };
    };
    const created = {
      ...(RECORDED_NEW_PROPOSAL as object),
      team: {
        ...(RECORDED_NEW_PROPOSAL as { team: object }).team,
        stages: replace.team.stages.map((stage) =>
          stage.id === 'build'
            ? { ...stage, howToWork: 'Write the tests first.' }
            : stage,
        ),
      },
    };
    const el = render(card({ input: created }));
    click(
      el.querySelector<HTMLButtonElement>(
        '[data-slot="team-proposal-stage-fold"] > button',
      )!,
    );
    const items = [
      ...el.querySelectorAll('[data-slot="team-proposal-stage-text"] > li'),
    ].map((item) => item.textContent);
    expect(items).toEqual([
      'PlanGoal The approach is agreed.',
      'BuildWrite the tests first.Goal The change is implemented with tests.',
      'ReviewGoal The reviewer approved the change.',
    ]);
  });

  it('draws no stages block for a team without stages', () => {
    const el = render(card());
    expect(el.querySelector('[data-slot="team-proposal-stages"]')).toBeNull();
    expect(el.textContent).not.toContain('stages');
  });

  it('holds Approve over a control character in an old stage value the change list decodes', () => {
    const input = STAGES_PROPOSAL as { diff: Record<string, unknown> };
    const tricked = {
      ...input,
      diff: {
        ...input.diff,
        changedStages: [
          {
            id: 'build',
            fields: [
              {
                field: 'goal',
                before: JSON.stringify('Old \u001b[2Jdone'),
                after: '"Tests pass"',
              },
            ],
          },
        ],
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+001B');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('folds the agents, still showing the ones a replacement changes', () => {
    const el = render(card({ input: RECORDED_REPLACE_PROPOSAL }));
    const fold = el.querySelector<HTMLButtonElement>(
      '[data-slot="team-proposal-agents"] > button',
    )!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toBe('2 agents · 1 changed, 1 more');
    const shown = () =>
      [...el.querySelectorAll<HTMLElement>('[data-agent]')].map(
        (row) => row.dataset.agent,
      );
    expect(shown()).toEqual(['reviewer']);
    expect(rosterRow(el, 'reviewer').textContent).toContain('Changed');

    click(fold);
    expect(fold.textContent).toBe('2 agents');
    expect(shown()).toEqual(['coder', 'reviewer']);
  });

  it('marks the agents a replacement adds and names their instruction blocks', () => {
    const el = render(card());
    openAgents(el);
    expect(rosterRow(el, 'coder').textContent).toContain('Changed');
    expect(rosterRow(el, 'tester').textContent).toContain('New');
    expect(rosterRow(el, 'coder').textContent).toContain('Blocks: Style');
    expect(rosterRow(el, 'tester').textContent).not.toContain('Blocks:');
  });

  it('folds the agents of a new team too, none of them marked', () => {
    const created = render(card({ input: RECORDED_NEW_PROPOSAL }));
    const fold = created.querySelector<HTMLButtonElement>(
      '[data-slot="team-proposal-agents"] > button',
    )!;
    expect(fold.textContent).toBe('2 agents');
    expect(created.querySelector('[data-agent]')).toBeNull();
    click(fold);
    expect(
      created.querySelector('[data-agent="coder"]')?.textContent,
    ).not.toMatch(/Changed|New/);
  });

  it('draws a long changed value as its two sides, one under the other', () => {
    const input = REPLACE_TO_AUTO_PROPOSAL as { diff: Record<string, unknown> };
    const before = `…report the result. ${'Never push to main. '.repeat(4)}…`;
    const after = `…report the result. ${'Save verified notes. '.repeat(4)}…`;
    const el = render(
      card({
        input: {
          ...input,
          diff: {
            ...input.diff,
            changedMembers: [
              {
                id: 'reviewer',
                fields: [
                  {
                    field: 'instructions',
                    before: JSON.stringify(before),
                    after: JSON.stringify(after),
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const row = [
      ...el.querySelectorAll<HTMLElement>('[data-slot="team-diff"] li'),
    ].find((item) => item.textContent?.includes('reviewer · instructions'))!;
    const value = row.querySelector('[data-slot="team-diff-value"]')!;
    expect(value.textContent).toBe(`−before: ${before}+after: ${after}`);
    expect(row.textContent).not.toContain('→');
  });

  it('folds the stage text, still showing the stages a replacement adds or changes', () => {
    const el = render(card({ input: STAGES_PROPOSAL }));
    const fold = el.querySelector<HTMLButtonElement>(
      '[data-slot="team-proposal-stage-fold"] > button',
    )!;
    expect(fold.textContent).toBe('3 stages · 2 changed, 1 more');
    const shown = () =>
      [...el.querySelectorAll<HTMLElement>('[data-stage]')].map((item) => [
        item.dataset.stage,
        item.querySelector('[data-slot="badge"]')?.textContent ?? null,
      ]);
    expect(shown()).toEqual([
      ['build', 'Changed'],
      ['review', 'New'],
    ]);
    click(fold);
    expect(shown()).toEqual([
      ['plan', null],
      ['build', 'Changed'],
      ['review', 'New'],
    ]);
  });

  it('folds the stage text of a replacement that leaves the stages as they were', () => {
    const input = STAGES_PROPOSAL as { diff: Record<string, unknown> };
    const el = render(
      card({
        input: {
          ...input,
          diff: {
            ...input.diff,
            addedStages: [],
            removedStages: [],
            changedStages: [],
            teamFields: [],
          },
        },
      }),
    );
    const fold = el.querySelector<HTMLButtonElement>(
      '[data-slot="team-proposal-stage-fold"] > button',
    )!;
    expect(fold.textContent).toBe('3 stages, unchanged');
    expect(
      el.querySelector('[data-slot="team-proposal-stage-text"]'),
    ).toBeNull();
    click(fold);
    expect(
      el.querySelector('[data-slot="team-proposal-stage-text"]'),
    ).not.toBeNull();
  });

  it('falls back to the permission body for an unparseable payload', () => {
    const el = render(
      card({ input: { mode: 'replace', slug: 'team', team: 'oops' } }),
    );
    expect(proposalCard(el)).toBeNull();
    expect(el.textContent).toContain('Agent asks to run a tool');
    expect(el.textContent).toContain(PROPOSE_TEAM);
  });

  describe('settled', () => {
    it('says it was saved and opens the saved team on its canvas', () => {
      const onOpenTeam = vi.fn();
      const el = render(
        card({
          verdict: true,
          outcome: { kind: 'saved', slug: 'review-pair' },
          onOpenTeam,
        }),
      );
      expect(el.textContent).toContain('✓ Saved as “review-pair”');
      click(buttonNamed(el, 'Open team')!);
      expect(onOpenTeam).toHaveBeenCalledWith('review-pair');
      openAgents(el);
      expect(rosterRow(el, 'coder')).not.toBeNull();
      expect(el.querySelector('[data-slot="team-diff"]')).not.toBeNull();
    });

    it('offers no canvas where the surface cannot open one', () => {
      const el = render(
        card({
          verdict: true,
          outcome: { kind: 'saved', slug: 'review-pair' },
        }),
      );
      expect(buttonNamed(el, 'Open team')).toBeUndefined();
    });

    it.each([
      [
        'changed',
        '“Review Pair” changed after this was proposed, so nothing was overwritten.',
      ],
      [
        'exists',
        'A team was saved as “review-pair” after this was proposed, so nothing was written.',
      ],
      [
        'gone',
        '“Review Pair” was deleted after this was proposed, and was not re-created.',
      ],
      ['not-closed', 'The card could not be closed, so nothing was written.'],
      ['write-failed', 'The team file could not be written.'],
      [null, 'Nothing was written.'],
    ] as const)(
      'says why an approval wrote nothing (%s)',
      (cause, sentence) => {
        const el = render(
          card({ verdict: true, outcome: { kind: 'not-saved', cause } }),
        );
        expect(el.textContent).toContain('✗ Not saved');
        expect(
          el.querySelector('[data-slot="team-not-saved"]')?.textContent,
        ).toBe(sentence);
        expect(buttonNamed(el, 'Open team')).toBeUndefined();
      },
    );

    it('reads an approval with no outcome on its row as approved, not saved', () => {
      const el = render(card({ verdict: true }));
      expect(el.textContent).toContain('✓ Approved');
      expect(el.textContent).not.toContain('Saved');
    });

    it('reads a declined card with the note it carried', () => {
      const el = render(card({ verdict: false, answer: 'one reviewer only' }));
      expect(el.textContent).toContain('✗ Declined');
      expect(el.textContent).toContain('one reviewer only');
      expect(buttonNamed(el, 'Approve')).toBeUndefined();
    });

    it('settles from Sending… once the verdict row arrives', () => {
      const onRespond = vi.fn();
      const el = render(card({ onRespond }));
      click(buttonNamed(el, 'Approve')!);
      rerender(
        card({
          onRespond,
          verdict: true,
          outcome: { kind: 'saved', slug: 'review-pair' },
        }),
      );
      expect(el.textContent).not.toContain('Sending…');
      expect(el.textContent).toContain('✓ Saved as “review-pair”');
    });

    it('says a card taken down unanswered expired', () => {
      const el = render(card({ expired: true }));
      expect(el.textContent).toContain('⏱ expired');
      expect(buttonNamed(el, 'Approve')).toBeUndefined();
    });
  });
});
