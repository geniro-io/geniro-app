// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
} from '../__fixtures__/workflow-proposals';

// React Flow measures through ResizeObserver, which jsdom has none of; the
// graph's own drawing is the preview's business, and the card is under test.
vi.mock('../workflows/workflow-preview', () => ({
  default: () => <div data-testid="workflow-preview" />,
}));

import { ApprovalCard } from './approval-card';
import { PROPOSE_WORKFLOW } from './geniro-tool';

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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

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
    toolName={PROPOSE_WORKFLOW}
    input={REPLACE_TO_AUTO_PROPOSAL}
    verdict={null}
    requestId="req-1"
    onRespond={vi.fn()}
    {...props}
  />
);

const proposalCard = (el: HTMLElement): HTMLElement | null =>
  el.querySelector('[data-slot="workflow-proposal-card"]');

const rosterRow = (el: HTMLElement, id: string): HTMLElement =>
  el.querySelector(`tr[data-agent="${id}"]`)!;

describe('WorkflowProposalCard', () => {
  it('names every auto agent in the strip and marks its roster row', () => {
    const el = render(card());
    const strip = el.querySelector('[data-slot="workflow-auto-strip"]');
    expect(strip?.getAttribute('role')).toBe('note');
    expect(strip?.textContent).toContain('2 agents run without asking');
    expect(strip?.textContent).toContain('Coder (coder)');
    expect(strip?.textContent).toContain('Tester (tester) — pool member 2');

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
    expect(el.querySelector('[data-slot="workflow-auto-strip"]')).toBeNull();
  });

  it('lists approval → auto changes first in the diff', () => {
    const el = render(card());
    const rows = [
      ...el.querySelectorAll('[data-slot="workflow-diff"] li'),
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

  it('says what a new workflow is, with no diff and no overwrite warning', () => {
    const el = render(card({ input: RECORDED_NEW_PROPOSAL }));
    expect(el.textContent).toContain('Review Pair');
    expect(el.textContent).toContain('New');
    expect(el.textContent).toContain('2 agents · 2 connections');
    expect(el.querySelector('[data-slot="workflow-diff"]')).toBeNull();
    expect(el.textContent).not.toContain('Approving overwrites');
  });

  it('warns a replacement overwrites the saved workflow, after a backup', () => {
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
      workflow: { nodes: Record<string, unknown>[] };
    };
    const tricked = {
      ...input,
      workflow: {
        ...input.workflow,
        nodes: input.workflow.nodes.map((node) =>
          node.id === 'reviewer'
            ? { ...node, role: 'Review \u202Eetirw ton od\u202C' }
            : node,
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
        changedNodes: { id: string; fields: Record<string, string>[] }[];
      };
    };
    const tricked = {
      ...input,
      diff: {
        ...input.diff,
        changedNodes: [
          {
            id: 'reviewer',
            fields: [
              {
                field: 'role',
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
        changedNodes: [
          {
            id: 'reviewer',
            fields: [
              {
                field: 'role',
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
      workflow: { nodes: Record<string, unknown>[] };
    };
    const tricked = {
      ...input,
      workflow: {
        ...input.workflow,
        nodes: input.workflow.nodes.map((node) =>
          node.id === 'coder' ? { ...node, role: 'Code \u001b[2Jfast' } : node,
        ),
      },
    };
    const el = render(card({ input: tricked }));
    expect(
      el.querySelector('[data-slot="hazard-warning"]')?.textContent,
    ).toContain('U+001B');
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(true);
  });

  it('does not gate a multi-line instruction for its line breaks', () => {
    const input = REPLACE_TO_AUTO_PROPOSAL as {
      workflow: { nodes: Record<string, unknown>[] };
    };
    const multiline = {
      ...input,
      workflow: {
        ...input.workflow,
        nodes: input.workflow.nodes.map((node) =>
          node.id === 'style'
            ? { ...node, instructions: 'Line one.\nLine two.\tIndented.' }
            : node,
        ),
      },
    };
    const el = render(card({ input: multiline }));
    expect(el.querySelector('[data-slot="hazard-warning"]')).toBeNull();
    expect(buttonNamed(el, 'Approve')!.disabled).toBe(false);
  });

  it('falls back to the permission body for an unparseable payload', () => {
    const el = render(
      card({ input: { mode: 'replace', slug: 'team', workflow: 'oops' } }),
    );
    expect(proposalCard(el)).toBeNull();
    expect(el.textContent).toContain('Agent asks to run a tool');
    expect(el.textContent).toContain(PROPOSE_WORKFLOW);
  });

  it('opens the graph larger from the card', async () => {
    const el = render(card());
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(el.querySelector('[data-testid="workflow-preview"]')).not.toBeNull();
    const opener = el.querySelector<HTMLButtonElement>(
      'button[aria-label^="Open a larger view of Review Pair"]',
    )!;
    expect(opener.getAttribute('aria-label')).toContain(
      'Graph: start → coder, coder → tester, tester → reviewer, style → coder.',
    );
    click(opener);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(
      document.querySelectorAll('[data-testid="workflow-preview"]'),
    ).toHaveLength(2);
  });

  it('still offers the graph once a window that hid it widens', () => {
    let narrow = true;
    const listeners: (() => void)[] = [];
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return narrow;
      },
      addEventListener: (_: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => undefined,
    }));
    try {
      const el = render(card());
      // A phone shows the graph only on request; shown, then hidden again.
      click(buttonNamed(el, 'Show graph')!);
      click(buttonNamed(el, 'Hide graph')!);
      narrow = false;
      act(() => {
        for (const listener of listeners) {
          listener();
        }
      });
      expect(el.querySelector('[data-testid="workflow-preview"]')).toBeNull();
      expect(buttonNamed(el, 'Show graph')).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('settled', () => {
    it('says it was saved and opens the saved workflow on its canvas', () => {
      const onOpenWorkflow = vi.fn();
      const el = render(
        card({
          verdict: true,
          outcome: { kind: 'saved', slug: 'review-pair' },
          onOpenWorkflow,
        }),
      );
      expect(el.textContent).toContain('✓ Saved as “review-pair”');
      click(buttonNamed(el, 'Open in canvas')!);
      expect(onOpenWorkflow).toHaveBeenCalledWith('review-pair');
      // The roster and the changes stay; the graph folds away.
      expect(rosterRow(el, 'coder')).not.toBeNull();
      expect(el.querySelector('[data-slot="workflow-diff"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="workflow-preview"]')).toBeNull();
      expect(buttonNamed(el, 'Show graph')).toBeDefined();
    });

    it('offers no canvas where the surface cannot open one', () => {
      const el = render(
        card({
          verdict: true,
          outcome: { kind: 'saved', slug: 'review-pair' },
        }),
      );
      expect(buttonNamed(el, 'Open in canvas')).toBeUndefined();
    });

    it.each([
      [
        'changed',
        '“Review Pair” changed after this was proposed, so nothing was overwritten.',
      ],
      [
        'exists',
        'A workflow was saved as “review-pair” after this was proposed, so nothing was written.',
      ],
      [
        'gone',
        '“Review Pair” was deleted after this was proposed, and was not re-created.',
      ],
      ['not-closed', 'The card could not be closed, so nothing was written.'],
      ['write-failed', 'The workflow file could not be written.'],
      [null, 'Nothing was written.'],
    ] as const)(
      'says why an approval wrote nothing (%s)',
      (cause, sentence) => {
        const el = render(
          card({ verdict: true, outcome: { kind: 'not-saved', cause } }),
        );
        expect(el.textContent).toContain('✗ Not saved');
        expect(
          el.querySelector('[data-slot="workflow-not-saved"]')?.textContent,
        ).toBe(sentence);
        expect(buttonNamed(el, 'Open in canvas')).toBeUndefined();
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
