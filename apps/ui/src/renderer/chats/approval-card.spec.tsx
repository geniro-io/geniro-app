// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';

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

/** TWIN LIMIT: mirrors approval-card.tsx / the daemon's chat.types.ts. */
const MAX_ANSWER_LENGTH = 32_768;

/** Type into a controlled input the way React's own value tracker sees it. */
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const tabsOf = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];

const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;

const click = (node: HTMLElement): void => {
  act(() => {
    node.click();
  });
};

describe('ApprovalCard', () => {
  it('renders the tool + input and fires the verdict callback while pending', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="Write"
        input={{ file_path: 'a.txt' }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.textContent).toContain('Write');
    expect(el.textContent).toContain('a.txt');

    const buttons = [...el.querySelectorAll('button')];
    const approve = buttons.find((b) => b.textContent === 'Approve')!;
    const deny = buttons.find((b) => b.textContent === 'Deny')!;
    act(() => {
      approve.click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(true);
    // The verdict channel is ONE-SHOT: after the first answer the card
    // freezes ("Sending…") until the persisted verdict item round-trips —
    // a follow-up Deny (or a double-click) must send nothing.
    act(() => {
      deny.click();
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Sending…');
    expect(
      [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Approve',
      ),
    ).toBeUndefined();
  });

  it('the freeze re-arms after the retry window when no verdict ever arrives', () => {
    // The verdict item can fail to persist (or the ack can be 'invalid');
    // the daemon settles a request exactly once, so re-offering the buttons
    // is safe — "Sending…" must not be forever.
    vi.useFakeTimers();
    try {
      const onRespond = vi.fn();
      const el = render(
        <ApprovalCard
          toolName="Write"
          input={{ file_path: 'a.txt' }}
          verdict={null}
          onRespond={onRespond}
        />,
      );
      const approve = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Approve',
      )!;
      act(() => {
        approve.click();
      });
      expect(el.textContent).toContain('Sending…');

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      // Buttons are back; a retry goes through.
      const retry = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Approve',
      );
      expect(retry).toBeDefined();
      act(() => {
        retry!.click();
      });
      expect(onRespond).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a question card freezes after picking an option — no double-submit window', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            { question: 'Which color?', options: [{ label: 'Red' }] },
          ],
        }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    const red = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Red',
    )!;
    act(() => {
      red.click();
    });
    act(() => {
      red.click();
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenLastCalledWith(true, 'Red');
    expect(el.textContent).toContain('Sending…');
  });

  it('renders an Edit permission as a red/green diff instead of raw JSON', () => {
    const el = render(
      <ApprovalCard
        toolName="Edit"
        input={{
          file_path: '/proj/stamp.txt',
          old_string: 'APPROVED',
          new_string: 'SEALED',
        }}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    const diff = el.querySelector('[data-slot="diff"]');
    expect(diff).not.toBeNull();
    expect(diff?.textContent).toContain('APPROVED');
    expect(diff?.textContent).toContain('SEALED');
    expect(el.textContent).toContain('/proj/stamp.txt');
    // The raw JSON body is replaced by the diff for edits under review.
    expect(el.textContent).not.toContain('"old_string"');
  });

  it('renders the settled state with no buttons once a verdict exists', () => {
    const el = render(
      <ApprovalCard
        toolName="Bash"
        input={{ command: 'ls' }}
        verdict={false}
        onRespond={vi.fn()}
      />,
    );
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).toContain('✗ denied');
  });

  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color should the header be?',
        header: 'Color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
      },
    ],
  };

  it('renders an AskUserQuestion as a question card: options answer with their label (M4)', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.textContent).toContain('Agent asks a question');
    expect(el.textContent).toContain('Which color should the header be?');
    const buttons = [...el.querySelectorAll('button')];
    const blue = buttons.find((b) => b.textContent === 'Blue')!;
    act(() => {
      blue.click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(true, 'Blue');
  });

  it('question card: free text answers ride the verdict, then the card freezes', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    const answerButton = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Answer',
    )!;
    // Empty free text must not be sendable.
    expect(answerButton.hasAttribute('disabled')).toBe(true);

    const input = el.querySelector('input')!;
    // Nearly the whole wire limit, minus room for the widest option label a
    // click could append: on this card a click IS the submit, so there is no
    // Submit button to disable if the two together overflow.
    expect(input.maxLength).toBe(MAX_ANSWER_LENGTH - 'Blue'.length - 2);
    act(() => {
      // React reads the value through its own tracker — set via the native
      // setter so the change event carries it.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'Teal, to match the logo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent === 'Answer')!
        .click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(true, 'Teal, to match the logo');

    // One-shot: the action row (incl. Decline) is gone until the persisted
    // verdict round-trips — no conflicting second verdict can be sent.
    expect(
      [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Decline',
      ),
    ).toBeUndefined();
    expect(el.textContent).toContain('Sending…');
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it('question card: Decline denies while the card is still pending', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    act(() => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent === 'Decline')!
        .click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(false);
  });

  it('question card renders the settled/expired states without answer controls', () => {
    const settled = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={true}
        onRespond={vi.fn()}
      />,
    );
    expect(settled.querySelectorAll('button')).toHaveLength(0);
    expect(settled.textContent).toContain('✓ answered');

    const expired = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        expired
        onRespond={vi.fn()}
      />,
    );
    expect(expired.querySelectorAll('button')).toHaveLength(0);
    expect(expired.textContent).toContain('expired');
  });

  it('an AskUserQuestion with a malformed payload falls back to the plain approval body', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{ garbage: true }}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    expect(el.textContent).toContain('Agent asks to run a tool');
  });

  it('a questions-shaped payload under any OTHER tool name renders the plain approval body', () => {
    // Name-only, matching the daemon's answer-fold gate: the card must never
    // collect an answer the daemon would refuse to deliver.
    const el = render(
      <ApprovalCard
        toolName="RenamedQuestionTool"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    expect(el.textContent).toContain('Agent asks to run a tool');
    expect(el.textContent).not.toContain('Agent asks a question');
  });

  const MULTI_QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color should the header be?',
        header: 'Color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
      },
      {
        question: 'Which font size?',
        header: 'Size',
        options: [{ label: 'Small' }, { label: 'Large' }],
        multiSelect: false,
      },
    ],
  };

  it('multi-question card is a TAB per question, and only the active one is on screen', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    const tabs = tabsOf(el);
    expect(tabs.map((t) => t.textContent)).toEqual(['Color', 'Size']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
    ]);
    // Only the selected question's text and options are mounted — the whole
    // point of tabs over a stacked list.
    expect(el.textContent).toContain('Which color should the header be?');
    expect(el.textContent).not.toContain('Which font size?');
    expect(buttonNamed(el, 'Blue')).toBeDefined();

    click(tabs[1]!);
    const afterSwitch = tabsOf(el);
    expect(afterSwitch.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);
    expect(el.textContent).toContain('Which font size?');
    expect(el.textContent).not.toContain('Which color should the header be?');
    // The panel is wired to its tab, so a screen reader announces the pair.
    const panel = el.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(afterSwitch[1]!.id);
  });

  it('every tab stays returnable and re-answerable until the one submission', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    click(buttonNamed(el, 'Blue'));
    // Staged, NOT sent: with more than one question a click cannot be the
    // whole answer.
    expect(onRespond).not.toHaveBeenCalled();
    expect(tabsOf(el)[0]!.dataset.answered).toBe('true');

    click(tabsOf(el)[1]!);
    click(buttonNamed(el, 'Large'));

    // Return to the first tab: the earlier pick survived the round trip...
    click(tabsOf(el)[0]!);
    expect(buttonNamed(el, 'Blue').getAttribute('aria-pressed')).toBe('true');
    // ...and is still changeable — re-answering is the point of the tabs.
    click(buttonNamed(el, 'Red'));
    expect(buttonNamed(el, 'Blue').getAttribute('aria-pressed')).toBe('false');
    expect(buttonNamed(el, 'Red').getAttribute('aria-pressed')).toBe('true');

    click(buttonNamed(el, 'Submit answers'));
    expect(onRespond).toHaveBeenCalledWith(
      true,
      'Which color should the header be?: Red\nWhich font size?: Large',
    );
  });

  it('arrow keys move between tabs, and the strip is one tab stop', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    // Roving tabindex: exactly one tab is reachable by Tab at a time.
    expect(tabsOf(el).map((t) => t.tabIndex)).toEqual([0, -1]);
    act(() => {
      tabsOf(el)[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(tabsOf(el).map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);
    expect(tabsOf(el).map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it('a tab with NO options is answerable by free text instead of deadlocking Submit', () => {
    // Regression: the multi-question path used to render no free-text field at
    // all, so an options-less question could never be answered and Submit
    // stayed disabled forever.
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            { question: 'Which color?', header: 'Color', options: [] },
            { question: 'Why?', header: 'Reason' },
          ],
        }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(buttonNamed(el, 'Submit answers').hasAttribute('disabled')).toBe(
      true,
    );
    typeInto(el.querySelector('input')!, 'Teal');
    click(tabsOf(el)[1]!);
    typeInto(el.querySelector('input')!, 'It matches the logo');

    const submit = buttonNamed(el, 'Submit answers');
    expect(submit.hasAttribute('disabled')).toBe(false);
    click(submit);
    expect(onRespond).toHaveBeenCalledWith(
      true,
      'Which color?: Teal\nWhy?: It matches the logo',
    );
  });

  it('free text QUALIFIES a pick rather than replacing it — on BOTH submit paths', () => {
    // Driven where a pick and typed text can actually coexist. The earlier
    // version of this test used a lone single-select question, where a click
    // answers outright and no pick is ever staged — so the join it was named
    // for could not run, and rewriting `answerAt` to discard picks left it
    // green.
    const staged = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={staged}
      />,
    );
    click(buttonNamed(el, 'Blue'));
    typeInto(el.querySelector('input')!, 'but a lighter shade');
    click(tabsOf(el)[1]!);
    click(buttonNamed(el, 'Large'));
    click(buttonNamed(el, 'Submit answers'));
    expect(staged).toHaveBeenCalledWith(
      true,
      'Which color should the header be?: Blue, but a lighter shade\nWhich font size?: Large',
    );

    // ...and the answer-on-click path must join identically. It did not: it
    // sent the label alone and dropped the qualifier onto a one-shot channel.
    const immediate = vi.fn();
    const single = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={immediate}
      />,
    );
    typeInto(single.querySelector('input')!, 'but a lighter shade');
    click(buttonNamed(single, 'Red'));
    expect(immediate).toHaveBeenCalledWith(true, 'Red, but a lighter shade');
  });

  it('keeps the typed qualifier when the answer is then picked from the options', () => {
    // Picking a label and typing beside it is ONE answer ("Red, but a lighter
    // shade") — the staged paths join both halves. The lone single-select
    // question must not send the label alone: the verdict channel is one-shot,
    // so words dropped here can never be sent again.
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    typeInto(el.querySelector('input')!, 'but a lighter shade');
    click(buttonNamed(el, 'Red'));
    // The pick may answer outright or stage for the action row — either way the
    // answer that leaves the card carries both halves.
    const submit = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Answer',
    );
    if (submit) {
      click(submit);
    }
    expect(onRespond).toHaveBeenLastCalledWith(
      true,
      'Red, but a lighter shade',
    );
  });

  it('a multiSelect question toggles several options into one answer', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            {
              question: 'Which files?',
              header: 'Files',
              options: [
                { label: 'a.ts' },
                { label: 'b.ts' },
                { label: 'c.ts' },
              ],
              multiSelect: true,
            },
          ],
        }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.textContent).toContain('Pick as many as apply.');
    // multiSelect suppresses the answer-on-click path even for ONE question:
    // a single click cannot be the whole answer here.
    click(buttonNamed(el, 'a.ts'));
    expect(onRespond).not.toHaveBeenCalled();
    click(buttonNamed(el, 'c.ts'));
    click(buttonNamed(el, 'b.ts'));
    click(buttonNamed(el, 'b.ts')); // toggles back off
    expect(buttonNamed(el, 'b.ts').getAttribute('aria-pressed')).toBe('false');

    click(buttonNamed(el, 'Submit answers'));
    expect(onRespond).toHaveBeenCalledWith(true, 'a.ts, c.ts');
  });

  it('an option label that eats the whole budget leaves no room to type', () => {
    // The answer-on-click path is the ONE submit path with no gate in front of
    // it: `canSubmit` guards Enter and the Submit button, but a click sends
    // outright. So the field must reserve room for the widest label — and when
    // that label already spends the budget, the honest reservation is zero,
    // not one. A floor of 1 let label + ", " + 1 char exceed the wire limit.
    const onRespond = vi.fn();
    const huge = 'x'.repeat(MAX_ANSWER_LENGTH - 1);
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [{ question: 'Pick', options: [{ label: huge }] }],
        }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.querySelector('input')!.maxLength).toBe(0);
    click(buttonNamed(el, huge));
    const [, answer] = onRespond.mock.calls[0]! as [boolean, string];
    expect(answer.length).toBeLessThanOrEqual(MAX_ANSWER_LENGTH);
  });

  it('a truthy-but-not-true multiSelect is NOT multi-select (twin parser rule)', () => {
    // Mirrored with claude-question.utils.ts: `=== true`, never Boolean(). A string
    // would make one twin offer multi-pick while the other offers one.
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            {
              question: 'Which color?',
              options: [{ label: 'Red' }],
              multiSelect: 'yes',
            },
          ],
        }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.textContent).not.toContain('Pick as many as apply.');
    click(buttonNamed(el, 'Red'));
    expect(onRespond).toHaveBeenCalledWith(true, 'Red');
  });

  it('an oversized or unfinished answer SAYS why Submit is disabled', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    // Unfinished: the blocked tabs are named, not left to be guessed.
    expect(el.textContent).toContain('still empty: Color, Size');
    click(buttonNamed(el, 'Blue'));
    expect(el.textContent).toContain('still empty: Size');
    expect(el.textContent).not.toContain('still empty: Color');

    // The budget's PURPOSE, not its arithmetic: filling every tab right up to
    // its own maxLength must still produce a submission the daemon accepts.
    // Pinning the number instead would just restate the formula and say
    // nothing about whether the formula is right.
    //
    // Each tab's budget is its OWN: tab 1 already carries a picked "Blue",
    // which rides in the same answer and so is charged against the same share.
    const fillToBudget = (fill: string): number => {
      const input = el.querySelector('input')!;
      expect(input.maxLength).toBeGreaterThan(0);
      typeInto(input, fill.repeat(input.maxLength));
      return input.maxLength;
    };
    const first = fillToBudget('x');
    click(tabsOf(el)[1]!);
    const second = fillToBudget('y');
    // The pick is charged: the tab holding "Blue" gets strictly less room.
    expect(first).toBeLessThan(second);
    expect(el.textContent).not.toContain('is the most the agent can receive');
    expect(buttonNamed(el, 'Submit answers').hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('says so when the answer is too long, instead of greying Submit out in silence', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    // maxLength bounds TYPING, not a programmatic set — and the daemon drops an
    // oversized verdict on the floor, so the card must refuse it out loud.
    typeInto(el.querySelector('input')!, 'x'.repeat(MAX_ANSWER_LENGTH));
    click(tabsOf(el)[1]!);
    typeInto(el.querySelector('input')!, 'y'.repeat(MAX_ANSWER_LENGTH));
    expect(el.textContent).toContain('is the most the agent can receive');
    expect(buttonNamed(el, 'Submit answers').hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('a long agent-written QUESTION cannot eat the budget its answer needs', () => {
    // The question text is agent-written and unbounded, and it prefixes the
    // answer in the submission. Uncapped, a wordy question pushed the blob past
    // the wire limit before the user typed anything — killing Submit with a
    // message blaming an answer that was not the cause.
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            { question: 'q'.repeat(20_000), header: 'A', options: [] },
            { question: 'r'.repeat(20_000), header: 'B', options: [] },
          ],
        }}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    expect(el.textContent).not.toContain('is the most the agent can receive');
    const budget = el.querySelector('input')!.maxLength;
    typeInto(el.querySelector('input')!, 'x'.repeat(budget));
    click(tabsOf(el)[1]!);
    typeInto(el.querySelector('input')!, 'y'.repeat(budget));
    expect(buttonNamed(el, 'Submit answers').hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('drops an oversized header, falling back to the question position (twin parser rule)', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={{
          questions: [
            { question: 'a', header: 'h'.repeat(65), options: [] },
            { question: 'b', header: 'h'.repeat(64), options: [] },
          ],
        }}
        verdict={null}
        onRespond={vi.fn()}
      />,
    );
    // 65 > MAX_QUESTION_HEADER_LENGTH → dropped; 64 is at the inclusive bound.
    expect(tabsOf(el).map((t) => t.textContent)).toEqual([
      'Question 1',
      'h'.repeat(64),
    ]);
  });

  it('a settled multi-question card lists every question and offers no controls', () => {
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={true}
        onRespond={vi.fn()}
      />,
    );
    // Tabs would hide half the record: a settled card is a transcript row.
    expect(tabsOf(el)).toHaveLength(0);
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.querySelector('input')).toBeNull();
    expect(el.textContent).toContain('Which color should the header be?');
    expect(el.textContent).toContain('Which font size?');
    expect(el.textContent).toContain('✓ answered');
  });

  it('tones a settled verdict by outcome — success for allowed, destructive for denied', () => {
    // Tool card: an approved verdict is toned success, not muted.
    const approved = render(
      <ApprovalCard
        toolName="Bash"
        input={{ command: 'ls' }}
        verdict={true}
        onRespond={vi.fn()}
      />,
    );
    const approvedLine = [...approved.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('✓ approved'),
    )!;
    expect(approvedLine.className).toContain('text-success');
    expect(approvedLine.className).not.toContain('text-muted-foreground');

    // Question card: a declined answer is toned destructive.
    const declined = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={QUESTION_INPUT}
        verdict={false}
        onRespond={vi.fn()}
      />,
    );
    const declinedLine = [...declined.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('✗ declined'),
    )!;
    expect(declinedLine.className).toContain('text-destructive');
    expect(declinedLine.className).not.toContain('text-muted-foreground');
  });
});
