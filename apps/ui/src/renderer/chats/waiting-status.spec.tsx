// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WaitReading } from './waiting';
import { WaitingStatus } from './waiting-status';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function reading(runId: string, state: WaitReading['state']): WaitReading {
  return { runId, state, since: '2026-10-21T10:00:00.000Z' };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(readings: WaitReading[], onJump = vi.fn()): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<WaitingStatus readings={readings} onJump={onJump} />);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('WaitingStatus', () => {
  it('counts each wait on the user in rank order, leaving working out', () => {
    const view = render([
      reading('a', 'unseen'),
      reading('b', 'asking'),
      reading('c', 'unseen'),
      reading('d', 'working'),
    ]);
    const counts = [...view.querySelectorAll('[data-wait-count]')].map(
      // The last child is the count; the mark before it carries its word.
      (node) => [
        node.getAttribute('data-wait-count'),
        node.lastChild?.textContent,
      ],
    );
    expect(counts).toEqual([
      ['asking', '1'],
      ['unseen', '2'],
    ]);
    expect(
      view
        .querySelector('[data-slot="waiting-status"]')
        ?.getAttribute('aria-label'),
    ).toBe('1 asking, 2 unread — open the one that has waited longest (⌘J)');
  });

  it('draws nothing while only working threads exist', () => {
    const view = render([reading('busy', 'working')]);
    expect(view.querySelector('[data-slot="waiting-status"]')).toBeNull();
  });

  it('jumps on a press', () => {
    const onJump = vi.fn();
    const view = render([reading('a', 'failed')], onJump);
    act(() => {
      view
        .querySelector<HTMLButtonElement>('[data-slot="waiting-status"]')
        ?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
