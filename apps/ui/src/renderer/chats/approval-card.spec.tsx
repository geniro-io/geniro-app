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
    expect(input.maxLength).toBe(32_768);
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

  it('multi-question card collects every option before submitting one combined answer', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="AskUserQuestion"
        input={MULTI_QUESTION_INPUT}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    // Both questions render with their option buttons...
    expect(el.textContent).toContain('Which color should the header be?');
    expect(el.textContent).toContain('Which font size?');
    // ...but the free-text Input + Answer are gone: a single free-text answer
    // maps to the ONE `response` wire channel, ambiguous across questions.
    expect(el.querySelector('input')).toBeNull();
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Answer');
    // Decline stays, and each question's options are staged locally.
    expect(labels).toContain('Decline');
    expect(labels).toContain('Blue');
    expect(labels).toContain('Large');
    const submit = [...el.querySelectorAll('button')].find(
      (button) => button.textContent === 'Submit answers',
    )!;
    expect(submit.hasAttribute('disabled')).toBe(true);

    act(() => {
      [...el.querySelectorAll('button')]
        .find((button) => button.textContent === 'Blue')!
        .click();
    });
    expect(onRespond).not.toHaveBeenCalled();
    expect(submit.hasAttribute('disabled')).toBe(true);

    act(() => {
      [...el.querySelectorAll('button')]
        .find((button) => button.textContent === 'Large')!
        .click();
    });
    expect(submit.hasAttribute('disabled')).toBe(false);
    act(() => {
      submit.click();
    });
    expect(onRespond).toHaveBeenCalledWith(
      true,
      'Which color should the header be?: Blue\nWhich font size?: Large',
    );
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
