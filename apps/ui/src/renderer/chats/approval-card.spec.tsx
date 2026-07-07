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
  it('renders the tool + input and fires the verdict callbacks while pending', () => {
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
    act(() => {
      deny.click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(false);
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

  it('question card: free text answers ride the verdict; Decline denies', () => {
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
});
