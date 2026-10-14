// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CallJumps,
  pickJumpAnchor,
  type TranscriptJump,
  type TranscriptJumpOptions,
  useTranscriptJump,
} from './use-transcript-jump';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The hook mounted in a bare root, its newest answer read through `current`. */
function renderJump(options: TranscriptJumpOptions): {
  result: { current: TranscriptJump };
  rerender: (next: Partial<TranscriptJumpOptions>) => void;
  unmount: () => void;
} {
  const result = { current: null as unknown as TranscriptJump };
  let current = options;
  const Harness = (): null => {
    result.current = useTranscriptJump(current);
    return null;
  };
  const host = document.createElement('div');
  const root: Root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  return {
    result,
    rerender: (next) => {
      current = { ...current, ...next };
      act(() => root.render(createElement(Harness)));
    },
    unmount: () => act(() => root.unmount()),
  };
}

/**
 * Anchors in DOCUMENT order, each carrying the seq its entry starts at.
 *
 * The two orders are given separately on purpose: the whole point of the
 * function is that they can disagree.
 */
const anchors = (...seqs: (number | string)[]): HTMLElement[] =>
  seqs.map((seq) => {
    const el = document.createElement('div');
    el.dataset.transcriptSeq = String(seq);
    return el;
  });

const seqOf = (el: HTMLElement | null): string | undefined =>
  el?.dataset.transcriptSeq;

describe('pickJumpAnchor', () => {
  it('lands on the entry that ENCLOSES the hit, not on an exact match', () => {
    // Most seqs have no anchor of their own: the fold collapses runs of rows
    // into one turn block, one tool group, one card. A jump to a row inside an
    // entry has to land on that entry.
    expect(seqOf(pickJumpAnchor(anchors(10, 20, 30), 25))).toBe('20');
    expect(seqOf(pickJumpAnchor(anchors(10, 20, 30), 20))).toBe('20');
  });

  it('picks by VALUE even where document order does not rise with seq', () => {
    // The regression this function exists for. A sub-agent block is PLACED
    // where its delegate was launched but STARTS at the first row the delegate
    // wrote, so the entry drawn after it can begin earlier — and a scan that
    // stopped at the first anchor past the hit would answer 10 here, sending
    // the reader to an entry two before the one holding their hit.
    expect(seqOf(pickJumpAnchor(anchors(10, 30, 20), 25))).toBe('20');
  });

  it('lands on the top of what is held when the hit is older than all of it', () => {
    // The honest landing place while the older page is still being fetched,
    // and it beats not moving at all.
    expect(seqOf(pickJumpAnchor(anchors(40, 50), 5))).toBe('40');
  });

  it('ignores an anchor whose seq will not parse, rather than landing on it', () => {
    expect(seqOf(pickJumpAnchor(anchors(10, 'later', 20), 25))).toBe('20');
  });

  it('answers null when there is nowhere to go at all', () => {
    expect(pickJumpAnchor([], 25)).toBeNull();
  });
});

describe('useTranscriptJump into a call', () => {
  let scroller: HTMLElement;
  let end: HTMLElement;
  const mounted: { unmount: () => void }[] = [];

  /** A row of the transcript, or of a card, carrying its seq the way each does. */
  function row(
    parent: HTMLElement,
    key: 'transcriptSeq' | 'callSeq',
    seq: number,
  ): void {
    const el = document.createElement('div');
    el.dataset[key] = String(seq);
    el.textContent = `row ${seq}`;
    parent.append(el);
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    scroller = document.createElement('div');
    end = document.createElement('div');
    row(scroller, 'transcriptSeq', 100);
    row(scroller, 'transcriptSeq', 200);
    scroller.append(end);
    document.body.append(scroller);
  });

  afterEach(() => {
    mounted.splice(0).forEach((hook) => hook.unmount());
    scroller.remove();
    vi.unstubAllGlobals();
  });

  /** The card a page of the run's own flow draws for call-1, with its own rows. */
  function drawCard(): void {
    const card = document.createElement('div');
    card.dataset.role = 'call-block';
    card.dataset.callBlock = 'card-1';
    for (const seq of [120, 140, 160]) {
      row(card, 'callSeq', seq);
    }
    scroller.insertBefore(card, end);
  }

  function mount(calls: CallJumps | undefined, loaded = [100, 200]) {
    const loadAround = vi.fn(async (_seq: number) => true);
    const hook = renderJump({
      threadId: 'run-1',
      items: loaded.map((seq) => ({ seq })),
      endRef: { current: end },
      followingRef: { current: true },
      setAboveTail: () => undefined,
      loadAround: (seq) => loadAround(seq),
      returnToTail: async () => true,
      calls,
    });
    mounted.push(hook);
    return { hook, loadAround };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("pages the window to the call's card, opens it, reads it back to the row and lands on the row inside it", async () => {
    let drawn = false;
    const openCard = vi.fn();
    const loadThrough = vi.fn(
      async (_conversation: string, _seq: number) => true,
    );
    const calls: CallJumps = {
      locate: async () => 'call-1',
      cardsOf: () => (drawn ? [{ id: 'card-1', conversation: 'call-1' }] : []),
      startOf: () => 110,
      openCard,
      loadThrough,
    };
    const { hook, loadAround } = mount(calls);
    loadAround.mockImplementation(async () => {
      drawCard();
      drawn = true;
      return true;
    });

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(loadAround).toHaveBeenCalledWith(110);
    expect(openCard).toHaveBeenCalledWith('card-1');
    expect(loadThrough).toHaveBeenCalledWith('call-1', 150);
    // The card's own row nearest at or below the hit — never the run's row
    // above the card (100) that a jump in the run's flow would pick.
    expect(hook.result.current.mark).toEqual({ seq: 140, cardId: 'card-1' });
    expect(hook.result.current.markedSeq).toBeNull();
  });

  it('lands in the run’s own flow for a row filed under no call', async () => {
    const { hook } = mount({
      locate: async () => null,
      cardsOf: () => [],
      startOf: () => null,
      openCard: vi.fn(),
      loadThrough: vi.fn(async () => true),
    });

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(hook.result.current.markedSeq).toBe(100);
  });

  it('lands in the run’s own flow when the row’s call cannot be learned', async () => {
    const { hook } = mount({
      locate: () => Promise.reject(new Error('daemon down')),
      cardsOf: () => [],
      startOf: () => null,
      openCard: vi.fn(),
      loadThrough: vi.fn(async () => true),
    });

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(hook.result.current.markedSeq).toBe(100);
  });

  it('lands at the call’s start when its card never appears', async () => {
    const { hook, loadAround } = mount(
      {
        locate: async () => 'call-1',
        cardsOf: () => [],
        startOf: () => 200,
        openCard: vi.fn(),
        loadThrough: vi.fn(async () => true),
      },
      [100, 200],
    );

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(loadAround).toHaveBeenCalledWith(200);
    expect(hook.result.current.markedSeq).toBe(200);
  });

  it("lands on the row inside a turn of the run's own flow, not on the turn's first row", async () => {
    const turn = document.createElement('div');
    turn.dataset.transcriptSeq = '300';
    for (const seq of [300, 310, 320]) {
      const inner = document.createElement('div');
      inner.dataset.rowSeq = String(seq);
      inner.textContent = `row ${seq}`;
      turn.append(inner);
    }
    scroller.insertBefore(turn, end);
    const { hook } = mount(undefined, [100, 320]);

    act(() => hook.result.current.jumpToSeq(315));
    await settle();

    expect(hook.result.current.markedSeq).toBe(310);
  });

  it("never lands a jump in the run's own flow on a row of an open card", async () => {
    drawCard();
    const cardTurn = scroller.querySelector<HTMLElement>('[data-call-block]')!;
    const inner = document.createElement('div');
    inner.dataset.rowSeq = '150';
    inner.textContent = 'callee row';
    cardTurn.append(inner);
    const { hook } = mount(undefined);

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(hook.result.current.markedSeq).toBe(100);
  });

  it('opens every card around a card drawn inside another, reads each through the row, and lands in the innermost', async () => {
    drawCard();
    const outer = scroller.querySelector<HTMLElement>('[data-call-block]')!;
    const inner = document.createElement('div');
    inner.dataset.role = 'call-block';
    inner.dataset.callBlock = 'card-2';
    row(inner, 'callSeq', 145);
    outer.append(inner);
    const openCard = vi.fn();
    const loadThrough = vi.fn(
      async (_conversation: string, _seq: number) => true,
    );
    const { hook } = mount({
      locate: async () => 'call-2',
      cardsOf: () => [
        { id: 'card-1', conversation: 'call-1' },
        { id: 'card-2', conversation: 'call-2' },
      ],
      startOf: () => 110,
      openCard,
      loadThrough,
    });

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(openCard.mock.calls).toEqual([['card-1'], ['card-2']]);
    expect(loadThrough.mock.calls).toEqual([
      ['call-1', 150],
      ['call-2', 150],
    ]);
    expect(hook.result.current.mark).toEqual({ seq: 145, cardId: 'card-2' });
  });

  it("lands on a card's own rows, never on a row of a card open inside it", async () => {
    drawCard();
    const outer = scroller.querySelector<HTMLElement>('[data-call-block]')!;
    const inner = document.createElement('div');
    inner.dataset.role = 'call-block';
    inner.dataset.callBlock = 'card-2';
    row(inner, 'callSeq', 145);
    outer.append(inner);
    const { hook } = mount({
      locate: async () => 'call-1',
      cardsOf: () => [{ id: 'card-1', conversation: 'call-1' }],
      startOf: () => 110,
      openCard: vi.fn(),
      loadThrough: vi.fn(async () => true),
    });

    act(() => hook.result.current.jumpToSeq(150));
    await settle();

    expect(hook.result.current.mark).toEqual({ seq: 140, cardId: 'card-1' });
  });

  it('drops a jump still on its way when another thread opens', async () => {
    drawCard();
    let answer: (callId: string | null) => void = () => undefined;
    const openCard = vi.fn();
    const { hook, loadAround } = mount({
      locate: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      cardsOf: () => [{ id: 'card-1', conversation: 'call-1' }],
      startOf: () => 110,
      openCard,
      loadThrough: vi.fn(async () => true),
    });

    act(() => hook.result.current.jumpToSeq(150));
    hook.rerender({ threadId: 'run-2' });
    answer('call-1');
    await settle();

    expect(openCard).not.toHaveBeenCalled();
    expect(loadAround).not.toHaveBeenCalled();
    expect(hook.result.current.mark).toBeNull();
  });

  it('never lands a jump the reader has already replaced with another', async () => {
    drawCard();
    let answer: (callId: string | null) => void = () => undefined;
    const loadThrough = vi.fn(async () => true);
    const { hook } = mount({
      locate: (seq) =>
        seq === 150
          ? new Promise((resolve) => {
              answer = resolve;
            })
          : Promise.resolve(null),
      cardsOf: () => [{ id: 'card-1', conversation: 'call-1' }],
      startOf: () => 110,
      openCard: vi.fn(),
      loadThrough,
    });

    act(() => hook.result.current.jumpToSeq(150));
    act(() => hook.result.current.jumpToSeq(200));
    await settle();
    answer('call-1');
    await settle();

    expect(loadThrough).not.toHaveBeenCalled();
    expect(hook.result.current.markedSeq).toBe(200);
  });
});
