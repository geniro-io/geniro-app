// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InitialsAvatar, initialsOf } from './avatar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('initialsOf', () => {
  it('auto-generates from the first letters of up to two words', () => {
    expect(initialsOf('Poet')).toBe('P');
    expect(initialsOf('Flaky (cursor)')).toBe('FC');
    expect(initialsOf('deep research helper')).toBe('DR');
    expect(initialsOf('')).toBe('?');
  });
});

describe('InitialsAvatar', () => {
  it('renders the initials with a deterministic tone per name', () => {
    act(() => root.render(<InitialsAvatar name="Orchestrator" />));
    const first = container.querySelector('[data-slot="avatar"]')!;
    expect(first.textContent).toBe('O');
    const tone = first.className;

    act(() => root.render(<InitialsAvatar name="Orchestrator" />));
    expect(container.querySelector('[data-slot="avatar"]')?.className).toBe(
      tone,
    );
  });

  it("the user's own avatar is the solid primary variant", () => {
    act(() => root.render(<InitialsAvatar name="U" solid />));
    expect(
      container.querySelector('[data-slot="avatar"]')?.className,
    ).toContain('bg-primary text-primary-foreground');
  });
});
