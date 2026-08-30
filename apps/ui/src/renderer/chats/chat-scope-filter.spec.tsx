// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatScopeFilter } from './chat-scope-filter';
import type { ChatListScope } from './use-chat-run';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(
  scope: ChatListScope,
  onChange: (next: ChatListScope) => void,
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChatScopeFilter scope={scope} onChange={onChange} />);
  });
  return host;
}

const trigger = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="Filter chats"]',
  )!;

const options = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="option"]'),
];

describe('ChatScopeFilter', () => {
  it('is ONE control, closed, until it is pressed', async () => {
    // The whole point of the replacement: a band of always-visible options
    // became one icon among the header's other three. A panel rendered without
    // a press is that band again under a different name.
    const container = await mount('active', vi.fn());

    expect(options(container)).toHaveLength(0);

    await act(async () => {
      trigger(container).click();
    });

    expect(options(container).map((el) => el.textContent)).toEqual([
      'Active chats',
      'Show all',
      'Archived only',
    ]);
  });

  it('reports the scope the pressed row names', async () => {
    const onChange = vi.fn();
    const container = await mount('active', onChange);
    await act(async () => {
      trigger(container).click();
    });

    await act(async () => {
      options(container)
        .find((el) => el.textContent === 'Show all')!
        .click();
    });

    expect(onChange).toHaveBeenCalledWith('all');
    // And it closes behind the press — a filter panel left standing covers the
    // list it just changed.
    expect(options(container)).toHaveLength(0);
  });

  it('says which scope is current, in words and in tone', async () => {
    // A collapsed control owes its user this much: an icon identical in all
    // three states leaves "why is this thread missing?" unanswerable on screen.
    const active = await mount('active', vi.fn());
    expect(trigger(active).title).toContain('Active chats');
    const untoned = trigger(active).className;

    act(() => root!.unmount());
    host!.remove();

    const archived = await mount('archived', vi.fn());
    expect(trigger(archived).title).toContain('Archived only');
    expect(trigger(archived).className).not.toBe(untoned);
  });
});
