// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ITEMS } from '../__fixtures__/recommendations';
import { RecommendationsApplyContext } from './recommendations-apply-context';
import { RecommendationsBlock } from './recommendations-block';
import { ThreadUiMemoryContext } from './thread-ui-memory';
import type { RecommendationsEntry } from './transcript-groups';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const ENTRY: RecommendationsEntry = {
  type: 'recommendations',
  id: 'i5',
  createdAt: '2026-10-14T10:00:00.000Z',
  seq: 5,
  nodeId: null,
  parentToolUseId: null,
  runId: 'analysis',
  card: { summary: null, timing: null, sourceKind: 'workflow', items: ITEMS },
  applied: null,
  outcomes: {},
};

async function render(
  apply: (runId: string, cardSeq: number, ids: string[]) => Promise<void>,
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecommendationsApplyContext.Provider value={apply}>
        <RecommendationsBlock entry={ENTRY} />
      </RecommendationsApplyContext.Provider>,
    );
  });
  return container;
}

function button(el: HTMLElement, name: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(
    (b) =>
      b.textContent?.includes(name) ||
      b.getAttribute('aria-label')?.startsWith(name),
  ) as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

describe('RecommendationsBlock', () => {
  it("applies this card's selection for its own run, then shows it as sent", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const el = await render(apply);

    await click(button(el, 'W-1'));
    await click(button(el, 'Apply selected'));

    expect(apply).toHaveBeenCalledWith('analysis', 5, ['W-1']);
    expect(
      el
        .querySelector('[data-slot="recommendations-card"]')!
        .getAttribute('data-state'),
    ).toBe('applying');
    expect(el.querySelector('[data-slot="recommendations-footer"]')).toBeNull();
  });

  it("keeps the selection open with the daemon's sentence when the Apply is refused", async () => {
    const apply = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'daemon POST /v1/chats/analysis/recommendations/apply failed (409): {"code":"RUN_BUSY","message":"the analysis is still working — apply once it has finished"}',
        ),
      );
    const el = await render(apply);

    await click(button(el, 'W-1'));
    await click(button(el, 'Apply selected'));

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'the analysis is still working',
    );
    expect(
      el
        .querySelector('[data-slot="recommendations-card"]')!
        .getAttribute('data-state'),
    ).toBe('selecting');
    expect(button(el, 'Apply selected').disabled).toBe(false);
  });

  it('keeps the ticked items through a redraw of the row, within the thread', async () => {
    const mount = async (): Promise<HTMLDivElement> => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <ThreadUiMemoryContext.Provider value="analysis-keep">
            <RecommendationsApplyContext.Provider value={vi.fn()}>
              <RecommendationsBlock entry={ENTRY} />
            </RecommendationsApplyContext.Provider>
          </ThreadUiMemoryContext.Provider>,
        );
      });
      return container;
    };
    const first = await mount();
    await click(button(first, 'W-1'));
    act(() => root?.unmount());
    first.remove();

    const again = await mount();

    expect(
      again.querySelector('[data-slot="recommendations-footer"]')?.textContent,
    ).toContain('1 of 4 selected');
  });
});
