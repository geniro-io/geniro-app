// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FastAction } from '../../shared/contracts';
import { FastActionBar } from './fast-action-bar';

let container: HTMLElement;
let root: Root;

const action = (over: Partial<FastAction> = {}): FastAction => ({
  id: 'fa-1',
  name: 'Review the branch',
  description: 'Review what changed on this branch and report findings.',
  ...over,
});

const render = (
  actions: FastAction[],
  onManage?: () => void,
): (() => string[]) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const pressed: string[] = [];
  act(() => {
    root.render(
      <FastActionBar
        actions={actions}
        onPress={(a) => pressed.push(a.id)}
        onManage={onManage}
      />,
    );
  });
  return () => pressed;
};

const buttons = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-slot="fast-action"]'),
];

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FastActionBar', () => {
  it('draws nothing at all for a user who has configured none', () => {
    // Which is most users. A surface that costs space for a feature nobody has
    // set up is a surface in the way — the same rule the composer shelf
    // follows directly above it.
    render([]);
    expect(container.querySelector('[data-slot="fast-action-bar"]')).toBeNull();
  });

  it('is one button per action, labelled by the NAME alone', () => {
    // The name is the whole label: an action carries no folder and no agent, so
    // there is no second fact to tell two of them apart by.
    render([
      action({ id: 'a', name: 'Review the branch' }),
      action({ id: 'b', name: 'Daily standup' }),
    ]);
    expect(buttons().map((b) => b.textContent)).toEqual([
      'Review the branch',
      'Daily standup',
    ]);
  });

  it('carries the whole description in the tooltip', () => {
    // The press writes this text into the user's own message box, so the one
    // moment reading it can still change the answer is before the press.
    render([action({ description: 'Write the tests first.' })]);
    expect(buttons()[0]?.getAttribute('title')).toBe('Write the tests first.');
    expect(buttons()[0]?.getAttribute('aria-label')).toBe(
      'Write the fast action “Review the branch” into the message',
    );
  });

  it('hands the whole action back on a press', () => {
    const pressed = render([action({ id: 'fa-7' })]);
    act(() => buttons()[0]?.click());
    expect(pressed()).toEqual(['fa-7']);
  });
});

describe('FastActionBar — reaching the editor', () => {
  it('offers the way back to Settings only alongside actions that exist', () => {
    // The bar is the only place the actions are visible, so the edit control
    // rides it — but a manage button over an empty set is the surface this bar
    // refuses to be, and Settings' own nav entry is how the first one is made.
    const manage = vi.fn();
    render([], manage);
    expect(
      container.querySelector('[data-slot="fast-action-manage"]'),
    ).toBeNull();

    act(() => root.unmount());
    container.remove();
    render([action()], manage);
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-slot="fast-action-manage"]',
    );
    act(() => edit?.click());
    expect(manage).toHaveBeenCalledTimes(1);
  });
});
