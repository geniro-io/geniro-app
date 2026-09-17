import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import { COMPACTED_WITHOUT_SUMMARY, CompactionRows } from './compaction-rows';
import { mapEventToItem } from './event-to-item';

const boundary = (
  trigger: string | null,
  extra: Partial<Extract<AgentEvent, { type: 'context_compacted' }>> = {},
): AgentEvent => ({
  type: 'context_compacted',
  phase: 'finished',
  trigger,
  preTokens: 977_032,
  postTokens: 28_921,
  ...extra,
});

/** Feed events in order, collecting every row they produce, as a caller does. */
function rowsOf(events: AgentEvent[], fold = new CompactionRows()) {
  const rows: { kind: string; payload: Record<string, unknown> }[] = [];
  for (const event of events) {
    const mapped = mapEventToItem(event);
    rows.push(...fold.rowsBefore(event, mapped));
    if (mapped) {
      rows.push(mapped);
    }
  }
  return { rows, fold };
}

describe('CompactionRows', () => {
  it('writes a row for an AUTOMATIC compaction that no summary follows, ahead of the next row', () => {
    // claude 2.1.266 puts only the boundary on the stream when the window fills
    // mid-turn, and the transcript used to carry no trace of it at all.
    const { rows } = rowsOf([
      boundary('auto'),
      { type: 'text', text: 'Carrying on with the parser.' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['system', 'message']);
    expect(rows[0]!.payload).toEqual({
      message: COMPACTED_WITHOUT_SUMMARY,
      severity: 'info',
      compaction: { preTokens: 977_032, postTokens: 28_921, trigger: 'auto' },
    });
  });

  it('stamps the figures onto the CLI summary when one follows, and writes no second row', () => {
    const { rows } = rowsOf([
      boundary('manual'),
      {
        type: 'notice',
        message: 'This session is being continued…',
        origin: 'cli',
      },
      { type: 'turn_complete', usage: null, stopReason: null, finalText: null },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['system', 'turn_complete']);
    expect(rows[0]!.payload).toMatchObject({
      message: 'This session is being continued…',
      origin: 'cli',
      compaction: { preTokens: 977_032, postTokens: 28_921, trigger: 'manual' },
    });
  });

  it('writes the row before the turn ends when the compaction was the last thing', () => {
    const { rows } = rowsOf([
      boundary('auto'),
      { type: 'turn_complete', usage: null, stopReason: null, finalText: null },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['system', 'turn_complete']);
  });

  it('keeps holding across events that produce no row, and flushes what is still owed', () => {
    const { rows, fold } = rowsOf([
      boundary('auto'),
      { type: 'text_delta', text: 'Carry' },
    ]);
    expect(rows).toEqual([]);
    expect(fold.holding).toBe(true);
    expect(fold.flush()).toHaveLength(1);
    expect(fold.holding).toBe(false);
    expect(fold.flush()).toEqual([]);
  });

  it('two compactions with nothing between them are two rows', () => {
    const { rows } = rowsOf([
      boundary('auto', { preTokens: 900_000 }),
      boundary('auto', { preTokens: 800_000 }),
      { type: 'text', text: 'ok' },
    ]);
    expect(
      rows
        .filter((row) => row.kind === 'system')
        .map(
          (row) => (row.payload.compaction as { preTokens: number }).preTokens,
        ),
    ).toEqual([900_000, 800_000]);
  });

  it("ignores a compaction that did not finish, and a delegate's own", () => {
    const { rows } = rowsOf([
      boundary(null, { phase: 'started', preTokens: null, postTokens: null }),
      boundary(null, { phase: 'failed', preTokens: null, postTokens: null }),
      boundary('auto', { parentToolUseId: 'toolu_delegate' }),
      { type: 'text', text: 'ok' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['message']);
  });

  it("does not stamp a delegate's notice as the main thread's summary", () => {
    const { rows } = rowsOf([
      boundary('auto'),
      {
        type: 'notice',
        message: 'relayed by a delegate',
        origin: 'cli',
        parentToolUseId: 'toolu_delegate',
      },
    ]);
    expect(rows.map((row) => row.payload.message)).toEqual([
      COMPACTED_WITHOUT_SUMMARY,
      'relayed by a delegate',
    ]);
    expect(rows[1]!.payload.compaction).toBeUndefined();
  });
});
