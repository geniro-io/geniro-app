// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AppView, NavRail } from './nav-rail';

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

function rail(
  view: AppView,
  onNavigate: (next: AppView) => void = () => undefined,
  collapsed = false,
  onToggleCollapsed: () => void = () => undefined,
): HTMLDivElement {
  return render(
    <NavRail
      view={view}
      onNavigate={onNavigate}
      collapsed={collapsed}
      hydrated
      onToggleCollapsed={onToggleCollapsed}
    />,
  );
}

const buttonNamed = (el: HTMLElement, label: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  ) as HTMLButtonElement;

describe('NavRail', () => {
  it('offers every top-level destination', () => {
    const el = rail('chats');

    for (const label of ['Chats', 'Graphs', 'Stats', 'Settings']) {
      expect(buttonNamed(el, label)).toBeTruthy();
    }
  });

  it('navigates to Stats when its row is clicked', () => {
    const onNavigate = vi.fn();
    const el = rail('chats', onNavigate);

    act(() => {
      buttonNamed(el, 'Stats').click();
    });

    expect(onNavigate).toHaveBeenCalledWith('stats');
  });

  it('marks the current destination for assistive tech', () => {
    const el = rail('stats');

    expect(buttonNamed(el, 'Stats').getAttribute('aria-current')).toBe('page');
    expect(buttonNamed(el, 'Chats').getAttribute('aria-current')).toBeNull();
  });

  it('keeps Settings pinned below the primary destinations', () => {
    const el = rail('chats');
    const labels = [...el.querySelectorAll('button')]
      .map((node) => node.textContent)
      .filter((text): text is string =>
        ['Chats', 'Graphs', 'Stats', 'Settings'].includes(text ?? ''),
      );

    // Stats is a primary destination, so it belongs with Chats and Graphs
    // rather than in the utility group Settings sits in.
    expect(labels).toEqual(['Chats', 'Graphs', 'Stats', 'Settings']);
  });

  it('keeps its own width toggle, in both directions', () => {
    // It moved to the title bar with everything else and moved straight back:
    // it acts on THIS column rather than on the window, so it belongs to the
    // column ("let's leave it in the menu itself, in the same place it was").
    const pressed: string[] = [];
    const open = rail(
      'chats',
      () => undefined,
      false,
      () => pressed.push('x'),
    );
    const toggle = open.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse menu"]',
    );
    expect(toggle).toBeTruthy();
    act(() => {
      toggle?.click();
    });
    expect(pressed).toEqual(['x']);

    act(() => {
      root?.unmount();
    });
    container?.remove();
    expect(
      rail('chats', () => undefined, true).querySelector(
        '[aria-label="Expand menu"]',
      ),
    ).toBeTruthy();
  });
});
