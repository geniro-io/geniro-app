// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Chip } from './chip';
import { Select } from './select';

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

const chip = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>('[data-slot="chip"]')!;

const trigger = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]')!;

describe('Chip tone', () => {
  // The composer row read as five equal pickers, two of which silently did
  // nothing. Tone is what tells "yours to change" from "stated for context",
  // so these two assertions must disagree with each other or the distinction
  // does not exist on screen.
  it('recedes by default — a bare chip states context, it does not offer a choice', () => {
    const el = chip(render(<Chip>geniro-app</Chip>));
    expect(el.className).toContain('text-muted-foreground');
    expect(el.className).not.toContain('text-foreground');
  });

  it('renders at full contrast when the value is the user’s', () => {
    const el = chip(render(<Chip tone="active">opus</Chip>));
    expect(el.className).toContain('text-foreground');
    expect(el.className).not.toContain('text-muted-foreground');
  });

  it('exposes the tone on the element, so a screen can be asserted on', () => {
    expect(chip(render(<Chip tone="active">opus</Chip>)).dataset.tone).toBe(
      'active',
    );
    expect(chip(render(<Chip>main</Chip>)).dataset.tone).toBe('muted');
  });
});

describe('the ghost Select trigger', () => {
  it('is always active-toned — a picker exists because the value is editable', () => {
    const el = render(
      <Select
        variant="ghost"
        value="opus"
        aria-label="Model"
        groups={[{ items: [{ value: 'opus', label: 'opus' }] }]}
        onValueChange={() => {}}
      />,
    );
    expect(trigger(el).className).toContain('text-foreground');
    expect(trigger(el).className).not.toContain('text-muted-foreground');
  });

  it('keeps the active tone while momentarily disabled', () => {
    // The approval chip locks mid-turn because the daemon 409s the change, but
    // it is still the user's control the moment the turn ends. Greying it would
    // say "not yours" about something that is — the lock is carried by the
    // disabled opacity, never by the tone.
    const el = render(
      <Select
        variant="ghost"
        value="auto"
        disabled
        aria-label="Tool-approval mode"
        groups={[{ items: [{ value: 'auto', label: 'auto-approve' }] }]}
        onValueChange={() => {}}
      />,
    );
    expect(trigger(el).className).toContain('text-foreground');
    expect(trigger(el).disabled).toBe(true);
  });
});
