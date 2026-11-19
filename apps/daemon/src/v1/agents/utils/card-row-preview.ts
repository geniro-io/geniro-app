import type { ItemKind } from '../../runs/runs.types';
import type { ItemWire } from '../chat.types';
import { collapseImageBlocks } from './collapse-image-blocks';
import { asRecord } from './json-util';

/**
 * The most of a card row's long text a page's anchors carry. A folded call card
 * reads these rows; an opened card's full rows replace them by id.
 */
export const CARD_ROW_PREVIEW_CHARS = 2000;

const PREVIEWED_FIELD: Partial<Record<ItemKind, string>> = {
  tool_call: 'input',
  tool_result: 'result',
  message: 'text',
};

/**
 * The row with its long text cut to {@link CARD_ROW_PREVIEW_CHARS}, or the same
 * row when nothing in its previewed field needs a cut.
 */
export function previewCardRow(row: ItemWire): ItemWire {
  const field = PREVIEWED_FIELD[row.kind];
  const payload = asRecord(row.payload);
  if (field === undefined || payload === null || !(field in payload)) {
    return row;
  }
  // Images first: a base64 block must become its line before any cut, or the
  // line would name the cut's size instead of the picture's.
  const value = cutLongStrings(collapseImageBlocks(payload[field]));
  return value === payload[field]
    ? row
    : { ...row, payload: { ...payload, [field]: value } };
}

/**
 * The card rows a page does not already hold or anchor, each as its preview —
 * a row the page holds or anchors is drawn, so it is never cut.
 */
export function previewCardRows(
  rows: readonly ItemWire[],
  served: (id: string) => boolean,
): ItemWire[] {
  return rows.filter((row) => !served(row.id)).map(previewCardRow);
}

function cutLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > CARD_ROW_PREVIEW_CHARS ? cutText(value) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const next = cutLongStrings(entry);
      changed = changed || next !== entry;
      return next;
    });
    return changed ? mapped : value;
  }
  const record = asRecord(value);
  if (record === null) {
    return value;
  }
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = cutLongStrings(entry);
    changed = changed || next !== entry;
    mapped[key] = next;
  }
  return changed ? mapped : value;
}

function cutText(text: string): string {
  const end = CARD_ROW_PREVIEW_CHARS;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut would leave half of a pair behind.
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? end - 1 : end);
}
