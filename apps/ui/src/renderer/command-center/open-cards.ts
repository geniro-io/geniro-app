import { useState } from 'react';

import type { ThreadAttention } from '../components/thread-labels';
import { useLatestCallback } from '../components/use-latest-callback';
import {
  hasFiniteNumbers,
  keptRunRecords,
  readRunRecords,
  type RunRecords,
  withRunRecord,
  writeRunRecords,
} from './run-records';

/** A card's own size in pixels: its width, and the height of the chat under its head. */
export interface CardSize {
  width: number;
  height: number;
}

/** Where a thread's node stood when its card opened, which it keeps while the card is open. */
export interface CardBand {
  attention: ThreadAttention;
  lastAt: string;
}

export interface OpenCard {
  runId: string;
  band: CardBand;
  /** Opened from inside the manager's window, so it stands over that window until it closes. */
  aboveWindow: boolean;
}

export const CARD_SIZES_KEY = 'commandCenter.cardSizes';
export const DEFAULT_CARD_SIZE: CardSize = { width: 460, height: 420 };
export const MIN_CARD_SIZE: CardSize = { width: 320, height: 220 };
export const MAX_REMEMBERED_CARD_SIZES = 200;

type CardSizes = RunRecords<CardSize>;

function isCardSize(value: unknown): value is CardSize {
  return hasFiniteNumbers(value, ['width', 'height']);
}

/** The card sizes this device remembers, by thread; empty when none or unreadable. */
export function readCardSizes(): CardSizes {
  return readRunRecords(CARD_SIZES_KEY, isCardSize);
}

/** `sizes` with `runId` set last, the oldest dropped past {@link MAX_REMEMBERED_CARD_SIZES}. */
export function withCardSize(
  sizes: CardSizes,
  runId: string,
  size: CardSize,
): CardSizes {
  return withRunRecord(sizes, runId, size, MAX_REMEMBERED_CARD_SIZES);
}

export interface OpenCards {
  /** In the order they opened. */
  cards: readonly OpenCard[];
  isOpen: (runId: string) => boolean;
  open: (runId: string, band: CardBand, aboveWindow?: boolean) => void;
  close: (runId: string) => void;
  toggle: (runId: string, band: CardBand) => void;
  /** Close every card whose thread left the board, and forget their sizes. */
  keepOnly: (runIds: ReadonlySet<string>) => void;
  sizeOf: (runId: string) => CardSize;
  resize: (runId: string, size: CardSize) => void;
}

/**
 * The threads open as cards on the command center's canvas — any number of
 * them, or on a phone the one opened last — and the size each card was left
 * at on this device.
 */
export function useOpenCards(narrow: boolean): OpenCards {
  const [cards, setCards] = useState<readonly OpenCard[]>([]);
  const [sizes, setSizes] = useState<CardSizes>(readCardSizes);

  const open = useLatestCallback(
    (runId: string, band: CardBand, aboveWindow = false): void =>
      setCards((rows) => {
        const kept = rows.find((row) => row.runId === runId);
        if (kept === undefined) {
          return [...(narrow ? [] : rows), { runId, band, aboveWindow }];
        }
        const marked =
          aboveWindow && !kept.aboveWindow
            ? rows.map((row) =>
                row === kept ? { ...row, aboveWindow: true } : row,
              )
            : rows;
        return narrow ? marked.filter((row) => row.runId === runId) : marked;
      }),
    [narrow],
  );
  const close = useLatestCallback(
    (runId: string): void =>
      setCards((rows) => rows.filter((row) => row.runId !== runId)),
    [],
  );
  const isOpen = (runId: string): boolean =>
    cards.some((row) => row.runId === runId);
  const toggle = useLatestCallback((runId: string, band: CardBand): void => {
    if (cards.some((row) => row.runId === runId)) {
      close(runId);
    } else {
      open(runId, band);
    }
  }, []);
  const keepOnly = useLatestCallback((runIds: ReadonlySet<string>): void => {
    setCards((rows) =>
      rows.every((row) => runIds.has(row.runId))
        ? rows
        : rows.filter((row) => runIds.has(row.runId)),
    );
    setSizes((current) => {
      const next = keptRunRecords(current, runIds);
      if (next !== current) {
        writeRunRecords(CARD_SIZES_KEY, next);
      }
      return next;
    });
  }, []);
  const sizeOf = (runId: string): CardSize => sizes[runId] ?? DEFAULT_CARD_SIZE;
  const resize = useLatestCallback(
    (runId: string, size: CardSize): void =>
      setSizes((current) => {
        const next = withCardSize(current, runId, size);
        writeRunRecords(CARD_SIZES_KEY, next);
        return next;
      }),
    [],
  );
  return { cards, isOpen, open, close, toggle, keepOnly, sizeOf, resize };
}
