// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boardCard } from '../__fixtures__/board-cards';
import {
  approvalRequest,
  questionRequest,
} from '../__fixtures__/open-requests';
import { ZoomableImage } from '../components/ui/image-viewer';
import { AttentionGallery } from './attention-gallery';
import { type AttentionCard, attentionCountsOf } from './use-attention-cards';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const QUESTION: AttentionCard = {
  key: 'request:q:q-1',
  at: '2026-11-27T08:00:00.000Z',
  kind: 'question',
  request: questionRequest('q', 'q-1'),
};
const APPROVAL: AttentionCard = {
  key: 'request:a:a-1',
  at: '2026-11-27T09:00:00.000Z',
  kind: 'approval',
  request: approvalRequest('a', 'a-1'),
};
const FAILED: AttentionCard = {
  key: 'failed:t2',
  at: '2026-11-27T09:30:00.000Z',
  kind: 'failed',
  card: boardCard('t2', { status: 'failed' }),
};
const FINISHED: AttentionCard = {
  key: 'finished:t1',
  at: '2026-11-27T10:00:00.000Z',
  kind: 'finished',
  card: boardCard('t1', { column: 'done' }),
};

function paint(
  cards: readonly AttentionCard[],
  onClose = vi.fn(),
  phone = false,
  open = true,
): HTMLElement {
  container ??= document.createElement('div');
  if (!container.isConnected) {
    document.body.appendChild(container);
  }
  root ??= createRoot(container);
  act(() =>
    root!.render(
      <AttentionGallery
        open={open}
        onClose={onClose}
        cards={cards}
        counts={attentionCountsOf(cards)}
        phone={phone}
        renderCard={(card) => (
          <div data-testid={card.key}>
            <span>{card.kind}</span>
            <button type="button">open {card.key}</button>
            <textarea aria-label={`answer ${card.key}`} />
          </div>
        )}
      />,
    ),
  );
  return document.body;
}

const current = (): string | null =>
  document.body
    .querySelector<HTMLElement>(
      '[data-slot="attention-card"][aria-current="true"]',
    )
    ?.getAttribute('data-card-key') ?? null;

const counter = (): string =>
  document.body.querySelector('[data-slot="attention-gallery-counter"]')
    ?.textContent ?? '';

const press = (slot: string): void =>
  act(() =>
    document.body
      .querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!
      .click(),
  );

const PICTURE_SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function paintPictures(cards: readonly AttentionCard[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <AttentionGallery
        open
        onClose={vi.fn()}
        cards={cards}
        counts={attentionCountsOf(cards)}
        phone={false}
        renderCard={(card) => (
          <ZoomableImage
            imgSlot="markdown-image"
            src={PICTURE_SRC}
            alt={`picture ${card.key}`}
          />
        )}
      />,
    ),
  );
}

const pictureOf = (cardKey: string): HTMLImageElement =>
  document.body.querySelector<HTMLImageElement>(
    `[data-card-key="${cardKey}"] img[data-slot="markdown-image"]`,
  )!;

const mouse = (
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
): void =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        pointerId: 1,
        button: 0,
        clientX,
      }),
    );
  });

function dragMouse(from: Element, by: number): void {
  mouse(from, 'pointerdown', 300);
  mouse(from, 'pointermove', 300 + by / 2);
  mouse(from, 'pointermove', 300 + by);
  mouse(from, 'pointerup', 300 + by);
  act(() => {
    (from as HTMLElement).click();
  });
}

const viewerOpen = (): boolean =>
  document.body.querySelector('[data-slot="image-viewer-image"]') !== null;

const key = (target: Element, name: string): void =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
  });

describe('AttentionGallery', () => {
  it('moves one card per press of → and ←, and the counter follows', () => {
    paint([QUESTION, APPROVAL, FINISHED]);

    expect(current()).toBe(QUESTION.key);
    expect(counter()).toBe('1 of 3');
    press('attention-gallery-next');
    expect(current()).toBe(APPROVAL.key);
    expect(counter()).toBe('2 of 3');
    press('attention-gallery-prev');
    expect(current()).toBe(QUESTION.key);
  });

  it('moves one card per arrow key, and not while typing an answer', () => {
    paint([QUESTION, APPROVAL]);
    const gallery = document.body.querySelector(
      '[data-slot="attention-gallery"]',
    )!;

    key(gallery, 'ArrowRight');
    expect(current()).toBe(APPROVAL.key);
    const field = document.body.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="answer ${APPROVAL.key}"]`,
    )!;
    key(field, 'ArrowLeft');
    expect(current()).toBe(APPROVAL.key);
  });

  it('keeps the card in view when a card arrives ahead of it', () => {
    paint([QUESTION, FINISHED]);
    press('attention-gallery-next');
    expect(current()).toBe(FINISHED.key);

    paint([QUESTION, APPROVAL, FINISHED]);

    expect(current()).toBe(FINISHED.key);
    expect(counter()).toBe('3 of 3');
  });

  it('opens on the first card, whatever arrived while it was closed', () => {
    paint([FINISHED], vi.fn(), false, false);
    paint([QUESTION, APPROVAL, FAILED, FINISHED], vi.fn(), false, false);

    paint([QUESTION, APPROVAL, FAILED, FINISHED]);

    expect(current()).toBe(QUESTION.key);
    expect(counter()).toBe('1 of 4');
  });

  it('opens again on the first card after it was closed on a later one', () => {
    paint([QUESTION, APPROVAL, FINISHED]);
    press('attention-gallery-next');
    press('attention-gallery-next');
    expect(counter()).toBe('3 of 3');

    paint([QUESTION, APPROVAL, FINISHED], vi.fn(), false, false);
    paint([QUESTION, APPROVAL, FINISHED]);

    expect(current()).toBe(QUESTION.key);
    expect(counter()).toBe('1 of 3');
  });

  it('puts the card that followed a done one in its place, not one that arrived there', () => {
    paint([QUESTION, APPROVAL, FINISHED]);
    press('attention-gallery-next');

    paint([QUESTION, FAILED, FINISHED]);

    expect(current()).toBe(FINISHED.key);
    expect(counter()).toBe('3 of 3');
  });

  it('keeps the arrow keys working once a press of → or ← reaches the end', () => {
    paint([QUESTION, APPROVAL]);
    const gallery = document.body.querySelector<HTMLElement>(
      '[data-slot="attention-gallery"]',
    )!;
    const next = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="attention-gallery-next"]',
    )!;
    act(() => next.focus());

    press('attention-gallery-next');

    expect(next.disabled).toBe(true);
    expect(document.activeElement).toBe(gallery);
    key(document.activeElement!, 'ArrowLeft');
    expect(current()).toBe(QUESTION.key);
  });

  it('keeps focus in the gallery when the card holding it moves out of view', () => {
    paint([QUESTION, APPROVAL, FINISHED]);
    const gallery = document.body.querySelector<HTMLElement>(
      '[data-slot="attention-gallery"]',
    )!;
    const open = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === `open ${QUESTION.key}`,
    )!;
    act(() => open.focus());

    key(open, 'ArrowRight');

    expect(current()).toBe(APPROVAL.key);
    expect(document.activeElement).toBe(gallery);
  });

  it('puts the next card in the place of one whose thing is done', () => {
    paint([QUESTION, APPROVAL, FINISHED]);
    press('attention-gallery-next');

    paint([QUESTION, FINISHED]);

    expect(current()).toBe(FINISHED.key);
  });

  it('lets only the card in view take focus', () => {
    paint([QUESTION, APPROVAL]);
    const slides = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-slot="attention-card"]',
      ),
    ];

    expect(slides.map((slide) => slide.hasAttribute('inert'))).toEqual([
      false,
      true,
    ]);
  });

  it('never blocks a sideways finger swipe on the track or a card', () => {
    paint([QUESTION, APPROVAL]);
    const swiped = [
      document.body.querySelector('[data-slot="attention-gallery-track"]')!,
      ...document.body.querySelectorAll('[data-slot="attention-card"]'),
    ];

    for (const element of swiped) {
      expect(element.className).not.toMatch(/touch-(pan-y|none)/);
      expect((element as HTMLElement).style.touchAction).toBe('');
    }
  });

  it('moves one card per mouse drag that starts on a picture, both ways, without opening it', () => {
    paintPictures([QUESTION, APPROVAL, FINISHED]);

    dragMouse(pictureOf(QUESTION.key), -120);
    expect(current()).toBe(APPROVAL.key);
    expect(viewerOpen()).toBe(false);

    dragMouse(pictureOf(APPROVAL.key), 120);
    expect(current()).toBe(QUESTION.key);
    expect(viewerOpen()).toBe(false);
  });

  it('moves one card per mouse drag that starts on a card, but not on its button', () => {
    paint([QUESTION, APPROVAL]);
    const text = document.body.querySelector(
      `[data-testid="${QUESTION.key}"] span`,
    )!;
    const button = [...document.body.querySelectorAll('button')].find(
      (element) => element.textContent === `open ${APPROVAL.key}`,
    )!;

    dragMouse(text, -120);
    expect(current()).toBe(APPROVAL.key);
    dragMouse(button, 120);
    expect(current()).toBe(APPROVAL.key);
  });

  it('keeps a picture from being dragged out of the gallery as an image', () => {
    paintPictures([QUESTION, APPROVAL]);
    const dragstart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      pictureOf(QUESTION.key).dispatchEvent(dragstart);
    });

    expect(dragstart.defaultPrevented).toBe(true);
  });

  it('still opens a picture on a plain click', () => {
    paintPictures([QUESTION, APPROVAL]);

    dragMouse(pictureOf(QUESTION.key), 0);

    expect(current()).toBe(QUESTION.key);
    expect(viewerOpen()).toBe(true);
  });

  it('holds one history entry on a phone, so one Back closes it', async () => {
    const before = window.history.length;

    paint([QUESTION], vi.fn(), true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.history.length - before).toBe(1);
  });

  it('says all caught up when nothing waits', () => {
    paint([]);

    expect(
      document.body.querySelector('[data-slot="attention-gallery-empty"]')
        ?.textContent,
    ).toContain('All caught up');
    expect(
      document.body.querySelector('[data-slot="attention-gallery-track"]'),
    ).toBeNull();
  });

  it('heads the gallery with the split by kind', () => {
    paint([QUESTION, APPROVAL, FINISHED]);

    expect(
      document.body.querySelector('[data-slot="attention-gallery-split"]')
        ?.textContent,
    ).toBe('1 question · 1 finished · 1 approval');
  });
});
