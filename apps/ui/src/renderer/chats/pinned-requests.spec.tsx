// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import { ThreadArchiveContext } from '../components/thread-archive';
import { PinnedRequests, waitingOnYouLabel } from './pinned-requests';
import { ThreadDoneDismissalsContext } from './thread-done-context';
import { ThreadOpenContext } from './thread-title';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

const OTTER = { runId: 'r-otter', title: 'Otter' };

const press = (el: HTMLElement, slot: string): void =>
  act(() =>
    el.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!.click(),
  );

describe('waitingOnYouLabel', () => {
  it('counts questions and finished threads, naming only the kinds that wait', () => {
    expect(waitingOnYouLabel(1)).toBe('Waiting on you · 1 question');
    expect(waitingOnYouLabel(1, 2)).toBe(
      'Waiting on you · 1 question · 2 finished',
    );
    expect(waitingOnYouLabel(0, 1)).toBe('Waiting on you · 1 finished');
  });
});

describe('PinnedRequests — finished threads', () => {
  function draw(
    over: {
      pinned?: boolean;
      dismiss?: (runId: string, seq: number | null) => void;
    } = {},
  ): {
    el: HTMLElement;
    open: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  } {
    const open = vi.fn();
    const archive = vi.fn();
    const requests = over.pinned === true ? [{ id: 'q-1' }] : [];
    const el = render(
      <ThreadDoneDismissalsContext.Provider
        value={{
          through: new Map(),
          finishes: new Map(),
          dismiss: over.dismiss ?? vi.fn(),
        }}>
        <ThreadArchiveContext.Provider value={() => archive}>
          <ThreadOpenContext.Provider value={open}>
            <PinnedRequests
              requests={requests}
              pinnedId={over.pinned === true ? 'q-1' : null}
              renderCard={() => <p data-slot="stub-card">question</p>}
              finished={[OTTER]}
            />
          </ThreadOpenContext.Provider>
        </ThreadArchiveContext.Provider>
      </ThreadDoneDismissalsContext.Provider>,
    );
    return { el, open, archive };
  }

  it('lists a finished thread under the pinned question, the header counting both', () => {
    const { el } = draw({ pinned: true });

    expect(
      el.querySelector('[data-slot="pinned-request-toggle"]')?.textContent,
    ).toBe('Waiting on you · 1 question · 1 finished');
    expect(el.querySelector('[data-slot="stub-card"]')).not.toBeNull();
    expect(
      el.querySelector('[data-slot="pinned-finished-line"]')?.textContent,
    ).toContain('Otter');
  });

  it('stands on its own when only finished threads wait', () => {
    const { el } = draw();

    expect(el.querySelector('[data-slot="stub-card"]')).toBeNull();
    expect(
      el
        .querySelector('[data-slot="pinned-request"]')
        ?.getAttribute('aria-label'),
    ).toBe('Finished threads waiting on you');
  });

  it('dismisses the finish on every device, archives and opens the thread from its line', () => {
    const dismiss = vi.fn();
    const { el, open, archive } = draw({ dismiss });

    press(el, 'pinned-finished-dismiss');
    expect(dismiss).toHaveBeenCalledWith('r-otter', null);
    press(el, 'pinned-finished-open');
    expect(open).toHaveBeenCalledWith('r-otter');
    press(el, 'pinned-finished-archive');
    expect(archive).toHaveBeenCalled();
  });
});
