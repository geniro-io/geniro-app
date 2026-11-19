import { describe, expect, it } from 'vitest';

import type { ItemKind } from '../../runs/runs.types';
import type { ItemWire } from '../chat.types';
import { CARD_ROW_PREVIEW_CHARS, previewCardRow } from './card-row-preview';

function rowOf(kind: ItemKind, payload: unknown): ItemWire {
  return {
    id: `${kind}-1`,
    runId: 'run-a',
    memberId: 'eng',
    seq: 1,
    kind,
    role: null,
    payload,
    createdAt: '2026-11-19T00:00:00.000Z',
    inCall: 'call-1',
  };
}

describe('previewCardRow', () => {
  it('cuts a long tool result to the preview cap', () => {
    const row = rowOf('tool_result', {
      id: 't1',
      result: 'x'.repeat(CARD_ROW_PREVIEW_CHARS + 1),
    });

    expect(previewCardRow(row).payload).toEqual({
      id: 't1',
      result: 'x'.repeat(CARD_ROW_PREVIEW_CHARS),
    });
  });

  it('cuts a long string nested in a tool call input, at any depth, and leaves a short one', () => {
    const long = 'y'.repeat(CARD_ROW_PREVIEW_CHARS + 500);
    const row = rowOf('tool_call', {
      id: 't2',
      name: 'Bash',
      input: { command: long, short: 'ls', edits: [{ text: long }] },
    });

    expect(previewCardRow(row).payload).toEqual({
      id: 't2',
      name: 'Bash',
      input: {
        command: 'y'.repeat(CARD_ROW_PREVIEW_CHARS),
        short: 'ls',
        edits: [{ text: 'y'.repeat(CARD_ROW_PREVIEW_CHARS) }],
      },
    });
  });

  it('cuts a long message text to the preview cap', () => {
    const row = rowOf('message', {
      text: 'z'.repeat(CARD_ROW_PREVIEW_CHARS * 3),
    });

    expect(previewCardRow(row).payload).toEqual({
      text: 'z'.repeat(CARD_ROW_PREVIEW_CHARS),
    });
  });

  it('returns a row needing no cut as the same object', () => {
    const row = rowOf('tool_result', { id: 't3', result: 'short' });

    expect(previewCardRow(row)).toBe(row);
  });

  it('leaves kinds it does not preview as they are, long text and all', () => {
    const row = rowOf('call_result', {
      callId: 'call-1',
      result: 'w'.repeat(CARD_ROW_PREVIEW_CHARS * 2),
    });

    expect(previewCardRow(row)).toBe(row);
  });

  it('leaves every field but the previewed one as it is', () => {
    const longId = 'i'.repeat(CARD_ROW_PREVIEW_CHARS * 2);
    const row = rowOf('tool_result', {
      id: longId,
      callId: 'call-1',
      result: 'short',
    });

    expect(previewCardRow(row)).toBe(row);
  });

  it('leaves a payload that is not an object as it is', () => {
    const row = rowOf('tool_result', 'not an object');

    expect(previewCardRow(row)).toBe(row);
  });

  it('never cuts inside a surrogate pair', () => {
    const text = `${'a'.repeat(CARD_ROW_PREVIEW_CHARS - 1)}😀${'b'.repeat(10)}`;
    const row = rowOf('message', { text });

    expect(previewCardRow(row).payload).toEqual({
      text: 'a'.repeat(CARD_ROW_PREVIEW_CHARS - 1),
    });
  });

  it("collapses a base64 image before the cut, so the line keeps the picture's size", () => {
    const row = rowOf('tool_result', {
      id: 't4',
      result: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'A'.repeat(4_096),
          },
        },
      ],
    });

    expect(previewCardRow(row).payload).toEqual({
      id: 't4',
      result: ['[image: image/png, 3 KB]'],
    });
  });
});
