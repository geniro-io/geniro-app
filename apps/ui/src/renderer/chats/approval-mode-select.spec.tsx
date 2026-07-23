// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalModeSelect } from './approval-mode-select';

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

function optionValues(el: HTMLElement): string[] {
  return [...el.querySelectorAll('option')].map((o) => o.value);
}

describe('ApprovalModeSelect', () => {
  it('offers ask / accept edits / auto and hides plan when the probe did not pass', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value="ask"
        planSupported={false}
        onChange={() => {}}
      />,
    );
    expect(optionValues(el)).toEqual(['ask', 'acceptEdits', 'auto']);
  });

  it('offers plan when the installed CLI probed pass, and fires onChange with the picked mode', () => {
    const onChange = vi.fn();
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value="ask"
        planSupported
        onChange={onChange}
      />,
    );
    expect(optionValues(el)).toEqual(['ask', 'acceptEdits', 'plan', 'auto']);
    const select = el.querySelector('select')!;
    act(() => {
      select.value = 'acceptEdits';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('acceptEdits');
  });

  it('keeps a stored plan value visible even when the probe says unsupported — the select never lies', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value="plan"
        planSupported={false}
        onChange={() => {}}
      />,
    );
    expect(optionValues(el)).toContain('plan');
  });

  it('renders a legacy null value as a one-way "cli default" placeholder', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value={null}
        planSupported={false}
        onChange={() => {}}
      />,
    );
    expect(el.textContent).toContain('cli default');
    expect(el.querySelector('select')!.value).toBe('');
  });

  it('pins cursor chats to a hinted auto-approve badge — no select at all', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="cursor-agent"
        value="auto"
        planSupported
        onChange={() => {}}
      />,
    );
    expect(el.querySelector('select')).toBeNull();
    expect(el.textContent).toContain('auto-approve');
    expect(el.firstElementChild?.getAttribute('title')).toContain(
      'no approval callback',
    );
  });

  it('disables the select while a turn is running', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value="ask"
        planSupported={false}
        disabled
        onChange={() => {}}
      />,
    );
    expect(el.querySelector('select')!.disabled).toBe(true);
  });
});
