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

  it('renders nothing at all for a cursor chat', () => {
    // cursor-agent has no per-turn approval channel — its permissions come
    // from the `--force` flag plus the static allow/deny list the CLI reads
    // from ~/.cursor/cli-config.json — so there is no choice to present. It
    // used to state the pinned mode as a badge; that was chrome on a decision
    // the user cannot make, and re-adding either the badge or a select would
    // regress what this pins as removed.
    const el = render(
      <ApprovalModeSelect
        agentKind="cursor-agent"
        value="auto"
        planSupported
        onChange={() => {}}
      />,
    );

    expect(el.querySelector('[data-menu-trigger]')).toBeNull();
    expect(el.textContent).toBe('');
    expect(el.children).toHaveLength(0);
  });

  it('LOCKS while a turn is running, unlike the model and effort chips', () => {
    // The odd one out among the composer chips, deliberately: this is the
    // permission control, so the daemon 409s a mid-turn change rather than ACK
    // a safety posture the running turn will not honour. A usable chip here
    // would let the user flip `auto → ask`, see the chip read `ask`, and have
    // the turn run fully auto-approved anyway.
    const el = render(
      <ApprovalModeSelect
        agentKind="claude"
        value="ask"
        planSupported={false}
        lockedMidTurn
        onChange={() => {}}
      />,
    );
    expect(trigger(el).disabled).toBe(true);
    expect(trigger(el).title).toContain('locked while a turn is running');
  });
});
