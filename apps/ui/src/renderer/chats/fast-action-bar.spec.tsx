// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunConfig } from '../../shared/contracts';
import { FastActionBar } from './fast-action-bar';

let container: HTMLElement;
let root: Root;

const action = (over: Partial<RunConfig> = {}): RunConfig => ({
  id: 'fa-1',
  name: 'Review the branch',
  cwd: '/Users/dev/geniro-app',
  branch: null,
  target: 'claude',
  model: null,
  effort: null,
  contextWindow: null,
  modelParameters: {},
  approval: null,
  configDir: null,
  firstMessage: null,
  ...over,
});

const render = (actions: RunConfig[], disabled = false): (() => string[]) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const pressed: string[] = [];
  act(() => {
    root.render(
      <FastActionBar
        actions={actions}
        disabled={disabled}
        onRun={(a) => pressed.push(a.id)}
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

  it('is one button per action, named by the action', () => {
    render([
      action({ id: 'a', name: 'Review the branch' }),
      action({ id: 'b', name: 'Daily standup' }),
    ]);
    expect(buttons().map((b) => b.textContent)).toEqual([
      'Review the branchgeniro-app',
      'Daily standupgeniro-app',
    ]);
  });

  it('says BEFORE the press which of the two kinds it is', () => {
    // An action with a message starts a chat and sends it; one without only
    // fills the chips in. Those are different consequences, so the button has
    // to distinguish them while it can still be un-pressed.
    render([
      action({ id: 'a', firstMessage: 'Review what changed.' }),
      action({ id: 'b', firstMessage: null }),
    ]);
    expect(buttons().map((b) => b.getAttribute('data-sends'))).toEqual([
      'message',
      'setup',
    ]);
    expect(buttons()[0]?.getAttribute('aria-label')).toBe(
      'Start a chat from the fast action Review the branch',
    );
    expect(buttons()[1]?.getAttribute('aria-label')).toBe(
      'Set the composer up from the fast action Review the branch',
    );
  });

  it('names the FOLDER, since a machine holds several checkouts', () => {
    render([action({ cwd: '/Users/dev/ManifestOS' })]);
    expect(buttons()[0]?.textContent).toContain('ManifestOS');
  });

  it('hands the whole action back on a press', () => {
    const pressed = render([action({ id: 'fa-7' })]);
    act(() => buttons()[0]?.click());
    expect(pressed()).toEqual(['fa-7']);
  });

  it('is dead while a turn is already running', () => {
    // Pressing would create a second chat under a composer that is mid-turn —
    // and the runner refuses it anyway, so the button must not look pressable.
    const pressed = render([action()], true);
    expect(buttons()[0]?.disabled).toBe(true);
    act(() => buttons()[0]?.click());
    expect(pressed()).toEqual([]);
  });
});
