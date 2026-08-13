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

  it('renders NO PICKER when the CLI reported no levels', () => {
    // Never a DISABLED picker: a dead dropdown states a choice the user does not
    // have. With no reason to show either, nothing renders at all — a chip whose
    // only explanation is still in flight reads as broken.
    const el = render(
      <EffortSelect efforts={[]} value={null} onChange={() => {}} />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('states the daemon’s reason on an inert chip when there are no levels', () => {
    // The absence has to explain itself: "I cannot change the effort of a Cursor
    // model" was reported against a picker that had silently vanished. The
    // sentence is the DAEMON's (`modelEfforts[]`), never composed here, and it is
    // hover-only so it costs a working composer nothing.
    const el = render(
      <EffortSelect
        efforts={[]}
        value={null}
        unavailableReason="this CLI takes no effort flag — set it in its own settings"
        onChange={() => {}}
      />,
    );

    expect(trigger(el)).toBeNull();
    expect(el.textContent).toContain('no effort control');
    expect(el.querySelector('[title]')?.getAttribute('title')).toBe(
      'this CLI takes no effort flag — set it in its own settings',
    );
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
