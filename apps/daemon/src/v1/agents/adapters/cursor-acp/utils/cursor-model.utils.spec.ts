import { describe, expect, it } from 'vitest';

import type { AcpConfigOption } from '../../acp/acp.types';
import {
  cursorBareModel,
  cursorEffortOption,
  cursorModelSelection,
} from './cursor-model.utils';

describe('cursorBareModel', () => {
  it('passes a bare id through, trimmed', () => {
    // What the parameterized handshake reports, and what claude's aliases are.
    expect(cursorBareModel('claude-opus-5')).toBe('claude-opus-5');
    expect(cursorBareModel(' opus ')).toBe('opus');
  });

  it('answers null for no model at all — "leave the agent on its own"', () => {
    expect(cursorBareModel(null)).toBeNull();
    expect(cursorBareModel(undefined)).toBeNull();
    expect(cursorBareModel('   ')).toBeNull();
  });
});

describe('cursorModelSelection', () => {
  it("appends the turn's effort, carrying every spelling of the axis", () => {
    const selection = cursorModelSelection('claude-opus-5', 'xhigh');

    expect(selection.model).toBe('claude-opus-5');
    expect(selection.parameters).toEqual([
      // It carries every spelling of the axis, so the driver can send
      // whichever one the model this turn runs on actually offers.
      {
        id: 'effort',
        value: 'xhigh',
        alternateIds: ['effort', 'reasoning', 'reasoning_effort'],
        category: 'thought_level',
      },
    ]);
  });

  it('carries an effort with no model, for a run on the CLI default', () => {
    // The ordinary case for a chat left on "default model". Requiring a model
    // here would make the picker inert for exactly those runs.
    expect(cursorModelSelection(null, 'max')).toEqual({
      model: null,
      parameters: [
        {
          id: 'effort',
          value: 'max',
          alternateIds: ['effort', 'reasoning', 'reasoning_effort'],
          category: 'thought_level',
        },
      ],
    });
  });

  it('adds nothing when the turn names no effort', () => {
    expect(cursorModelSelection('claude-opus-5', null)).toEqual({
      model: 'claude-opus-5',
      parameters: [],
    });
    expect(cursorModelSelection('claude-opus-5', '  ')).toEqual({
      model: 'claude-opus-5',
      parameters: [],
    });
  });

  it("appends the turn's context window, applied before the prompt", () => {
    const selection = cursorModelSelection('claude-opus-5', null, '1m');

    expect(selection.model).toBe('claude-opus-5');
    expect(selection.parameters).toEqual([
      // ONE spelling, so no `alternateIds`: swept across all 34 models, every
      // one that has the axis calls it `context`.
      { id: 'context', value: '1m', applyBeforePrompt: true },
    ]);
  });

  it('carries both axes at once', () => {
    const selection = cursorModelSelection('claude-opus-5', 'max', '1m');

    expect(selection.parameters).toEqual([
      {
        id: 'effort',
        value: 'max',
        alternateIds: ['effort', 'reasoning', 'reasoning_effort'],
        category: 'thought_level',
      },
      { id: 'context', value: '1m', applyBeforePrompt: true },
    ]);
  });

  it('carries a window with no model, for a run on the CLI default', () => {
    // The ordinary case for a chat left on "default model": the seeded profile
    // still has a current model, and its `context` option is set on that.
    expect(cursorModelSelection(null, null, '1m')).toEqual({
      model: null,
      parameters: [{ id: 'context', value: '1m', applyBeforePrompt: true }],
    });
  });

  it('adds nothing when the turn names no window', () => {
    expect(cursorModelSelection('claude-opus-5', null, null)).toEqual({
      model: 'claude-opus-5',
      parameters: [],
    });
    expect(cursorModelSelection('claude-opus-5', null, '  ')).toEqual({
      model: 'claude-opus-5',
      parameters: [],
    });
  });
});

describe('cursorModelSelection — the other model parameters', () => {
  it('sends every parameter the run carries, verbatim, after the axes with chips', () => {
    // Verbatim in both halves: geniro holds no vocabulary for these, so the id
    // and the value are the CLI's own words round-tripped. Ordering matters
    // only in that the model frame goes first — these ride behind it like the
    // effort and the window, since a parameter's very existence depends on
    // which model is current.
    const selection = cursorModelSelection('auto-smart', null, null, {
      optimize_for: 'intelligence',
    });

    expect(selection.model).toBe('auto-smart');
    expect(selection.parameters).toEqual([
      { id: 'optimize_for', value: 'intelligence' },
    ]);
  });

  it('refuses to set an axis that already has a control of its own', () => {
    // The map is stored per run and could carry an id that later gained a chip
    // — or one written by a build where it had not yet. Letting it through
    // would set the same option twice: once from the chip the user pressed and
    // once from the map, with the map winning by arriving last.
    const selection = cursorModelSelection('claude-opus-5', 'high', '1m', {
      effort: 'low',
      reasoning: 'low',
      context: '300k',
      mode: 'plan',
      optimize_for: 'cost',
    });

    expect(selection.parameters.map((p) => [p.id, p.value])).toEqual([
      ['effort', 'high'],
      ['context', '1m'],
      ['optimize_for', 'cost'],
    ]);
  });

  it('leaves the selection untouched when the run names none', () => {
    const bare = cursorModelSelection('auto-smart', null, null);
    expect(cursorModelSelection('auto-smart', null, null, {})).toEqual(bare);
    expect(cursorModelSelection('auto-smart', null, null, null)).toEqual(bare);
  });
});

/**
 * Every option below is VERBATIM from a `session/new` reply of cursor-agent
 * 2026.09.10-fd3934a, swept across all 37 models of one account on 2026-09-22.
 */
describe('cursorEffortOption', () => {
  const option = (
    id: string,
    category: string | null,
    values: string[],
  ): AcpConfigOption => ({
    id,
    name: 'Effort',
    category,
    currentValue: values[0] ?? null,
    options: values.map((value) => ({ value, name: value })),
  });

  /** `thought_level`'s OTHER axis, on 10 of the 37 models. */
  const THINKING = option('thinking', 'thought_level', ['false', 'true']);
  const CONTEXT = option('context', 'model_config', ['300k', '1m']);

  it('takes the spelling the model enumerated, whichever one it is', () => {
    for (const id of ['effort', 'reasoning', 'reasoning_effort']) {
      expect(
        cursorEffortOption([
          CONTEXT,
          THINKING,
          option(id, 'thought_level', ['low', 'medium', 'high']),
        ])?.id,
      ).toBe(id);
    }
  });

  it('adopts an UNMEASURED spelling from its category', () => {
    // The whole reason this is not a list lookup: `grok-4.7` and
    // `gemini-3.8-flash` renamed the axis inside a vendor release, and the
    // next rename must not draw the picker twice again.
    expect(
      cursorEffortOption([
        CONTEXT,
        THINKING,
        option('deliberation', 'thought_level', ['low', 'high']),
      ])?.id,
    ).toBe('deliberation');
  });

  it('never adopts a toggle, and never a graded option of another category', () => {
    // `thinking` alone is `claude-opus-4-5`: a model with no effort axis at
    // all, which must read as none rather than as a switch to write levels to.
    expect(cursorEffortOption([CONTEXT, THINKING])).toBeNull();
    expect(
      cursorEffortOption([
        option('optimize_for', 'model_config', ['intelligence', 'cost']),
      ]),
    ).toBeNull();
  });

  it('adopts nothing when the category holds two graded options', () => {
    expect(
      cursorEffortOption([
        option('deliberation', 'thought_level', ['low', 'high']),
        option('rumination', 'thought_level', ['low', 'high']),
      ]),
    ).toBeNull();
  });

  it('is not fooled by an option the agent named with no values', () => {
    expect(
      cursorEffortOption([option('effort', 'thought_level', [])]),
    ).toBeNull();
  });
});
