// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EffortSelect } from './effort-select';

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

const trigger = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]');

/** The menu's rows — the picker is ours, so they are real DOM, not an OS menu. */
function optionValues(el: HTMLElement): string[] {
  act(() => {
    trigger(el)!.click();
  });
  return [...el.querySelectorAll('[role="option"]')].map(
    (o) => o.textContent ?? '',
  );
}

/** What the daemon reports for claude — its probe-verified vocabulary. */
const CLAUDE_LEVELS = [
  { id: 'low', label: 'low' },
  { id: 'high', label: 'high' },
  { id: 'ultracode', label: 'ultracode' },
];

describe('EffortSelect', () => {
  it('offers exactly the levels the daemon reported, plus a default row', () => {
    // No vocabulary is baked in here: claude accepts `ultracode` while its own
    // --help does not name it, so a list written on this side would be wrong.
    const el = render(
      <EffortSelect efforts={CLAUDE_LEVELS} value="high" onChange={() => {}} />,
    );
    expect(optionValues(el)).toEqual([
      'low',
      'high',
      'ultracode',
      'default effort',
    ]);
  });

  it('renders NOTHING when the CLI reported no levels — never a disabled chip', () => {
    // cursor-agent folds reasoning effort into its model ids, so there is no
    // separate control. A disabled chip (or a static badge) would state a
    // choice the user does not have; re-adding either regresses this.
    const el = render(
      <EffortSelect efforts={[]} value={null} onChange={() => {}} />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('reports the picked level, and null for the default row', () => {
    const onChange = vi.fn();
    const el = render(
      <EffortSelect efforts={CLAUDE_LEVELS} value="low" onChange={onChange} />,
    );
    act(() => {
      el.querySelectorAll<HTMLElement>('[data-menu-trigger]')[0]!.click();
    });
    const options = el.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => {
      options[2]!.click();
    });
    expect(onChange).toHaveBeenCalledWith('ultracode');

    act(() => {
      trigger(el)!.click();
    });
    const reopened = el.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => {
      reopened[reopened.length - 1]!.click();
    });
    // null, not the sentinel string: "no --effort at all" must not reach the
    // daemon as a level named `__default__`.
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a stored level the CLI no longer lists visible — the chip never lies', () => {
    const el = render(
      <EffortSelect
        efforts={CLAUDE_LEVELS}
        value="legacy-level"
        onChange={() => {}}
      />,
    );
    expect(trigger(el)!.textContent).toContain('legacy-level');
    expect(optionValues(el)).toContain('legacy-level');
  });
});
