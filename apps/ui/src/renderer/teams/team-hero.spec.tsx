// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamHero, UNMEASURED_FIGURES } from './team-hero';

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
  vi.restoreAllMocks();
});

function setHeights(scrollHeight: number, clientHeight: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(
    scrollHeight,
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
    clientHeight,
  );
}

function hero(description: string | null): void {
  act(() =>
    root.render(
      <TeamHero
        name="Dev Team"
        description={description}
        people={[{ key: 'ada', name: 'Ada' }]}
        memberCount={1}
        stageCount={0}
        figures={UNMEASURED_FIGURES}
      />,
    ),
  );
}

function toggle(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Show'),
  );
}

describe('TeamHero', () => {
  it('holds a long description to three readable lines behind Show more', () => {
    setHeights(400, 72);
    hero('A long description. '.repeat(80));
    const body = container.querySelector('[data-slot="team-description"]')!;
    expect(body.className).toContain('line-clamp-3');
    expect(body.className).toContain('max-w-[72ch]');
    expect(toggle()?.textContent).toBe('Show more');
    act(() => toggle()!.click());
    expect(body.className).not.toContain('line-clamp-3');
    expect(toggle()?.textContent).toBe('Show less');
  });

  it('offers no toggle for a description that fits', () => {
    setHeights(48, 48);
    hero('Plans a change and ships it.');
    expect(toggle()).toBeUndefined();
  });

  it('draws no description for a blank one', () => {
    hero('   ');
    expect(container.querySelector('[data-slot="team-description"]')).toBe(
      null,
    );
  });
});
