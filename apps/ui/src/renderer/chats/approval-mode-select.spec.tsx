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

const trigger = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]')!;

/** The menu's rows — the picker is ours, so they are real DOM, not an OS menu. */
function optionValues(el: HTMLElement): string[] {
  act(() => {
    trigger(el).click();
  });
  return [...el.querySelectorAll('[role="option"]')].map(
    (o) => o.textContent ?? '',
  );
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
    expect(optionValues(el)).toEqual(['ask', 'accept edits', 'auto-approve']);
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
    expect(optionValues(el)).toEqual([
      'ask',
      'accept edits',
      'plan',
      'auto-approve',
    ]);
    act(() => {
      el.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click();
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
    expect(trigger(el).textContent).toContain('cli default');
  });

  it('offers cursor chats a real approval select, minus the claude-only plan mode', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="cursor-agent"
        value="ask"
        // Even with the claude probe reporting plan support, cursor must not
        // be offered it — that verdict says nothing about cursor's own modes.
        planSupported
        onChange={() => {}}
      />,
    );
    // ACP makes session/request_permission a baseline, so these are real.
    expect(el.querySelector('[data-menu-trigger]')).not.toBeNull();
    expect(optionValues(el)).toEqual(['ask', 'accept edits', 'auto-approve']);
  });

  it('keeps a stored plan visible for cursor, so the select never lies', () => {
    const el = render(
      <ApprovalModeSelect
        agentKind="cursor-agent"
        value="plan"
        planSupported={false}
        onChange={() => {}}
      />,
    );
    // The trigger shows `plan`; a menu without that row would display a value
    // the user cannot see or re-pick.
    expect(optionValues(el)).toContain('plan');
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
    expect(trigger(el).disabled).toBe(true);
  });
});
