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
  it('invites the first one where a user with none would look for it', () => {
    // Which is every user on their first launch. The new-chat screen is where a
    // fast action is wanted, so drawing nothing left the feature findable only
    // by somebody already hunting through Settings for it.
    const manage = vi.fn();
    render([], manage);
    const add = container.querySelector<HTMLButtonElement>(
      '[data-slot="fast-action-add"]',
    );
    expect(add?.textContent).toBe('Add fast actions');
    act(() => add?.click());
    expect(manage).toHaveBeenCalledTimes(1);
    // And nothing that belongs to a configured bar: no action row, and not the
    // glyph either — over an empty set the trip to Settings is spelled out.
    expect(buttons()).toEqual([]);
    expect(
      container.querySelector('[data-slot="fast-action-manage"]'),
    ).toBeNull();
  });

  it('draws nothing at all with no actions AND no way to Settings', () => {
    // The harness case: an invitation to a screen the caller cannot open is a
    // button that does nothing.
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
  it('rides the bar as a glyph once there are actions beside it', () => {
    // The bar is the only place the actions are visible, so the edit control
    // rides it. Alongside buttons that say what the bar is, a glyph carries the
    // trip; the empty bar spells it out instead (pinned above).
    const manage = vi.fn();
    render([action()], manage);
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-slot="fast-action-manage"]',
    );
    act(() => edit?.click());
    expect(manage).toHaveBeenCalledTimes(1);
  });
});
