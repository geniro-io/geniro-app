import { describe, expect, it } from 'vitest';

import { openDelegateIds } from './open-delegates';

/** One `subagent_info` payload, as `event-to-item.ts` writes it. */
function info(
  id: string,
  lifecycle: {
    backgroundOpen?: boolean | null;
    backgroundOutcome?: string | null;
  } = {},
): unknown {
  return {
    id,
    label: null,
    kind: null,
    prompt: null,
    model: null,
    durationMs: null,
    tokens: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    stepsUnavailableReason: null,
    backgroundOpen: lifecycle.backgroundOpen ?? null,
    backgroundOutcome: lifecycle.backgroundOutcome ?? null,
  };
}

describe('openDelegateIds', () => {
  it('reports a delegate the CLI declared out and never closed', () => {
    expect(openDelegateIds([info('task-a', { backgroundOpen: true })])).toEqual(
      ['task-a'],
    );
  });

  it('drops one the CLI closed, on either channel', () => {
    // `backgroundOpen: false` is "it is over" with nothing else said; an
    // outcome is the CLI naming HOW. Both close, and each has to on its own:
    // claude answers with the first, and the daemon's own repair writes both.
    expect(
      openDelegateIds([
        info('by-flag', { backgroundOpen: true }),
        info('by-flag', { backgroundOpen: false }),
        info('by-outcome', { backgroundOpen: true }),
        info('by-outcome', { backgroundOutcome: 'stopped' }),
      ]),
    ).toEqual([]);
  });

  it('lets a stated OUTCOME close a row that still says open', () => {
    // The ranking, and it mirrors the renderer's `subagentBlockStatus`: a
    // backgrounded delegate's launching call is answered within the second, so
    // the outcome is the only field that speaks about the WORK. Reading the
    // flag first would leave a reported delegate listed as out.
    expect(
      openDelegateIds([
        info('task-a', { backgroundOpen: true }),
        info('task-a', {
          backgroundOpen: true,
          backgroundOutcome: 'completed',
        }),
      ]),
    ).toEqual([]);
  });

  it('reads a row that claims neither as saying NOTHING', () => {
    // The announcement carrying a delegate's label or its duration is not a
    // lifecycle claim — cursor sends exactly that, an anchor at launch and the
    // brief when it arrives. Reading it as a close would retire a delegate
    // that is out, which is the failure this whole path exists to prevent.
    expect(
      openDelegateIds([
        info('task-a', { backgroundOpen: true }),
        info('task-a'),
      ]),
    ).toEqual(['task-a']);
  });

  it('keeps launch order, and keeps it across a reopen', () => {
    // The closes are written in this order, and a delegate that goes open →
    // closed → open again must stay where it started rather than jump to the
    // end: the ids are what a reader pairs with the transcript's own rows.
    expect(
      openDelegateIds([
        info('first', { backgroundOpen: true }),
        info('second', { backgroundOpen: true }),
        info('first', { backgroundOpen: false }),
        info('first', { backgroundOpen: true }),
      ]),
    ).toEqual(['first', 'second']);
  });

  it('steps over anything that is not a readable row', () => {
    // These payloads come back off disk as `unknown`, and a transcript written
    // by an older build is exactly where a shape that no longer parses turns
    // up. One unreadable row must cost its own delegate and never the sweep.
    expect(
      openDelegateIds([
        null,
        'not an object',
        { id: 42, backgroundOpen: true },
        { backgroundOpen: true },
        { id: '', backgroundOpen: true },
        info('task-a', { backgroundOpen: true }),
      ]),
    ).toEqual(['task-a']);
  });
});
