// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';
import { PROPOSE_PLAN, readPlan } from './plan-card';

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

const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;

const click = (node: HTMLElement): void => {
  act(() => {
    node.click();
  });
};

/** Type into the controlled note box the way React's value tracker sees it. */
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

const PLAN = {
  title: 'Make the queue test deterministic',
  steps: [
    { title: 'Reproduce it', detail: 'Run the suite 20× with --seed' },
    { title: 'Replace the sleep with a wait-for' },
  ],
};

const card = (
  props: Partial<React.ComponentProps<typeof ApprovalCard>> = {},
): React.ReactElement => (
  <ApprovalCard
    toolName={PROPOSE_PLAN}
    input={PLAN}
    verdict={null}
    onRespond={() => {}}
    {...props}
  />
);

describe('readPlan', () => {
  it('reads a plan the daemon wrote', () => {
    expect(readPlan(PLAN)).toEqual({
      title: 'Make the queue test deterministic',
      steps: [
        { title: 'Reproduce it', detail: 'Run the suite 20× with --seed' },
        { title: 'Replace the sleep with a wait-for', detail: null },
      ],
    });
  });

  it('refuses every shape that is not one', () => {
    // The twin parser is defensive on purpose: a transcript replayed from an
    // older daemon must route to the permission body, never crash the row.
    for (const input of [
      null,
      'a plan',
      [],
      {},
      { title: 'no steps' },
      { title: 'bad steps', steps: 'one, two' },
      { title: 'nothing readable', steps: [{}, null, { detail: 'x' }] },
      { steps: [{ title: 'no title on the plan' }] },
    ]) {
      expect(readPlan(input)).toBeNull();
    }
  });
});

describe('PlanCard', () => {
  it('draws the steps IN ORDER, numbered, with their details', () => {
    const el = render(card());
    const steps = [...el.querySelectorAll('li')];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.textContent).toContain('1.');
    expect(steps[0]?.textContent).toContain('Reproduce it');
    expect(steps[0]?.textContent).toContain('Run the suite 20× with --seed');
    expect(steps[1]?.textContent).toContain('2.');
    expect(steps[1]?.textContent).toContain(
      'Replace the sleep with a wait-for',
    );
    // The plan's own title is the heading — not the tool name, which is what
    // the permission body would have shown.
    expect(el.textContent).toContain('Make the queue test deterministic');
    expect(el.textContent).not.toContain(PROPOSE_PLAN);
  });

  it('sends a bare verdict when nothing is typed', () => {
    // Arity matters at the far end: the daemon's note branch must not be
    // entered with an empty string, which it would then quote back at the user.
    const onRespond = vi.fn();
    const el = render(card({ onRespond }));
    click(buttonNamed(el, 'Approve'));
    expect(onRespond).toHaveBeenCalledWith(true);
  });

  it('sends the NOTE with either verdict, trimmed', () => {
    // The reason this card beats a prose plan: a rejection that says what to
    // do instead redirects the agent in the same press.
    for (const [label, allow] of [
      ['Approve', true],
      ['Reject', false],
    ] as const) {
      const onRespond = vi.fn();
      const el = render(card({ onRespond }));
      typeInto(el.querySelector('textarea')!, '  leave the parser alone  ');
      click(buttonNamed(el, label));
      expect(onRespond).toHaveBeenCalledWith(allow, 'leave the parser alone');
    }
  });

  it('FREEZES after one press, so a double-click cannot send twice', () => {
    const onRespond = vi.fn();
    const el = render(card({ onRespond }));
    click(buttonNamed(el, 'Approve'));
    expect(el.textContent).toContain('Sending…');
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it('shows the verdict and the note back once settled', () => {
    const el = render(
      card({ verdict: false, answer: 'leave the parser alone' }),
    );
    expect(el.textContent).toContain('rejected');
    expect(el.textContent).toContain('leave the parser alone');
    // The plan stays on screen: the rest of the conversation refers back to it.
    expect(el.textContent).toContain('Reproduce it');
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('says so when the turn ended before an answer', () => {
    const el = render(card({ expired: true }));
    expect(el.textContent).toContain('expired');
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('falls back to the PERMISSION body for an unreadable plan', () => {
    // A malformed call is still answerable — the same rule an AskUserQuestion
    // whose payload parses to nothing obeys.
    const el = render(card({ input: { title: 'no steps here' } }));
    expect(buttonNamed(el, 'Deny')).toBeTruthy();
    expect(el.querySelector('ol')).toBeNull();
  });
});
