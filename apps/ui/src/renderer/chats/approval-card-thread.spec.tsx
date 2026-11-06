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

const SEND = {
  thread: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  message: `First line\n${'x'.repeat(1_200)}\nthe closing words`,
  wake: true,
};

describe('a message to another thread, as an approval card', () => {
  it('draws the whole message under the title of the thread it would reach', () => {
    const el = render(
      <ApprovalCard
        toolName="message_thread"
        input={SEND}
        threadTitle="Pelican"
        verdict={null}
        requestId="req-1"
        onRespond={() => {}}
      />,
    );
    expect(el.textContent).toContain('Agent asks to send a message to Pelican');
    expect(el.textContent).toContain('the closing words');
  });

  it('is approved or denied in one press, with no acknowledgment for its line breaks and no option to remember it', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="message_thread"
        input={SEND}
        threadTitle="Pelican"
        verdict={null}
        requestId="req-1"
        onRespond={onRespond}
      />,
    );
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Approve',
      'Deny',
    ]);
    act(() => buttons[1]!.click());
    expect(onRespond.mock.calls[0]?.[0]).toBe(false);
  });

  it('shows the settled answer and offers no buttons once answered', () => {
    const el = render(
      <ApprovalCard
        toolName="message_thread"
        input={SEND}
        threadTitle="Pelican"
        verdict={true}
        requestId="req-1"
        onRespond={() => {}}
      />,
    );
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).toContain('✓ approved');
  });

  it('draws the ordinary permission card when no thread title is given', () => {
    const el = render(
      <ApprovalCard
        toolName="message_thread"
        input={SEND}
        verdict={null}
        requestId="req-1"
        onRespond={() => {}}
      />,
    );
    expect(el.textContent).toContain('Agent asks to run a tool');
    expect(el.textContent).not.toContain('Agent asks to send a message');
  });
});
