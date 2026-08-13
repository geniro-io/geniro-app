import { describe, expect, it } from 'vitest';

import { readCursorTask } from './cursor-task.utils';

/**
 * The params in the first case are the ones captured off the wire on
 * cursor-agent 2026.08.11-e8db854 (2026-08-13), not a shape invented for the
 * test — see the `Background sub-agents` block in `cursor-acp.const.ts`.
 */
describe('readCursorTask', () => {
  it('reads the announcement the CLI actually sends', () => {
    expect(
      readCursorTask({
        toolCallId: 'toolu_018bc7mNH8ULKFNFSSEhvkPY',
        description: 'List files in directory',
        prompt: 'Your task is simple and self-contained: list every file …',
        subagentType: { custom: { unspecified: {} } },
        model: 'claude-opus-5-thinking-high',
        agentId: 'bce43ebb-cf88-4adf-bb10-33f0b5458f45',
        durationMs: 13075,
      }),
    ).toEqual({
      id: 'toolu_018bc7mNH8ULKFNFSSEhvkPY',
      label: 'List files in directory',
      kind: null,
      prompt: 'Your task is simple and self-contained: list every file …',
      model: 'claude-opus-5-thinking-high',
      durationMs: 13075,
    });
  });

  it('drops `agentId`, which names a conversation nothing here can open', () => {
    // The delegate's own transcript lives in the CLI's private per-project blob
    // store. Carrying the id would put an identifier on the wire that no reader
    // can act on — and would look, to a later reader, like a thread geniro can
    // fetch.
    const facts = readCursorTask({
      toolCallId: 't-1',
      agentId: 'bce43ebb',
    });
    expect(facts).not.toBeNull();
    expect(Object.keys(facts ?? {})).not.toContain('agentId');
  });

  it('names a declared sub-agent type, in either shape the CLI sends it', () => {
    // A type it knows arrives as a bare string; anything else is wrapped by the
    // oneof, where the NAME is the single key of the inner object.
    expect(
      readCursorTask({ toolCallId: 't', subagentType: 'explore' })?.kind,
    ).toBe('explore');
    expect(
      readCursorTask({ toolCallId: 't', subagentType: { custom: 'reviewer' } })
        ?.kind,
    ).toBe('reviewer');
    expect(
      readCursorTask({
        toolCallId: 't',
        subagentType: { custom: { 'video_review': {} } },
      })?.kind,
    ).toBe('video_review');
  });

  it('reads the CLI’s "no type given" spellings as no type, not as a label', () => {
    // The observed shape for a plain delegation. Labelling that delegate
    // `unspecified` in the block header would state a role nobody chose.
    for (const subagentType of [
      'unspecified',
      'UNSPECIFIED',
      'default',
      { custom: { unspecified: {} } },
      { custom: 'unspecified' },
      '',
      {},
    ]) {
      expect(
        readCursorTask({ toolCallId: 't', subagentType })?.kind,
      ).toBeNull();
    }
  });

  it('answers null only when there is no tool call to anchor to', () => {
    // The id is the join to the row that launched the delegate; without it the
    // announcement cannot be attached to anything, and the driver declines it.
    expect(readCursorTask({ description: 'orphan' })).toBeNull();
    expect(readCursorTask({ toolCallId: '' })).toBeNull();
    expect(readCursorTask(null)).toBeNull();
    expect(readCursorTask('nonsense')).toBeNull();
  });

  it('keeps a delegate whose every OTHER field is missing', () => {
    // A failed delegation reports no duration, and a plain one names no type. A
    // row saying "a sub-agent ran and we know nothing else" is still true, where
    // refusing the announcement would throw away the anchor as well.
    expect(readCursorTask({ toolCallId: 't-9' })).toEqual({
      id: 't-9',
      label: null,
      kind: null,
      prompt: null,
      model: null,
      durationMs: null,
    });
  });

  it('reads the CLI’s empty strings as absent fields', () => {
    // Measured: `description` and `prompt` are coalesced to `""` by the CLI's
    // own sender when the args carry none, so `""` is how "not sent" arrives.
    expect(
      readCursorTask({
        toolCallId: 't',
        description: '',
        prompt: '',
        model: '',
      }),
    ).toMatchObject({ label: null, prompt: null, model: null });
  });
});
