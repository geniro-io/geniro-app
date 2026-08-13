import { describe, expect, it } from 'vitest';

import {
  cursorModelEffort,
  cursorModelSelection,
  splitCursorModelId,
} from './cursor-model.utils';

/**
 * Every id below is VERBATIM from a `session/new` reply of cursor-agent
 * 2026.08.11-e8db854 (33 models enumerated), so a release that reshapes the id
 * format fails here rather than silently reporting no effort for every model.
 */
describe('cursorModelEffort', () => {
  it('reads the effort= parameter, whatever its position in the bracket', () => {
    expect(
      cursorModelEffort(
        'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      ),
    ).toBe('high');
    // Leading position, so the `[` boundary is the one that matches.
    expect(cursorModelEffort('gemini-3.6-flash[effort=high]')).toBe('high');
    expect(cursorModelEffort('grok-4.6[effort=high,fast=true]')).toBe('high');
    expect(
      cursorModelEffort(
        'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]',
      ),
    ).toBe('xhigh');
  });

  it('reads the OpenAI-family spelling too — one axis, two vendor names', () => {
    // `reasoning=` is the same user-facing choice under a different key. Reading
    // only `effort=` reported "no effort" for every gpt/kimi/glm row, which is
    // 13 of the 33 this account is offered.
    expect(
      cursorModelEffort('gpt-5.5[context=272k,reasoning=medium,fast=false]'),
    ).toBe('medium');
    expect(cursorModelEffort('kimi-k3[reasoning=max]')).toBe('max');
    expect(cursorModelEffort('glm-5.2[reasoning=high]')).toBe('high');
  });

  it('answers null for an id that genuinely states none', () => {
    // Real rows, not invented ones: these models are offered with no effort
    // parameter at all, and claiming one for them would be inventing it.
    expect(cursorModelEffort('gemini-3.1-pro[]')).toBeNull();
    expect(cursorModelEffort('claude-opus-4-5[thinking=true]')).toBeNull();
    expect(cursorModelEffort('composer-2.5[fast=true]')).toBeNull();
    expect(cursorModelEffort('auto-smart[optimize_for=balanced]')).toBeNull();
    // claude's ids, which are bare aliases — the other adapter passes null
    // itself, but this must not start reading something out of them either.
    expect(cursorModelEffort('opus')).toBeNull();
  });

  it('will not read a parameter that merely ENDS in the key', () => {
    // The boundary guard, entered deliberately. Without it a future
    // `max_effort=` or `no_reasoning=` parameter is read as the effort itself,
    // and the picker then states a value the model does not have.
    expect(cursorModelEffort('some-model[max_effort=high]')).toBeNull();
    expect(cursorModelEffort('some-model[no_reasoning=low]')).toBeNull();
  });

  it('treats an empty value as absent rather than as an empty effort', () => {
    // `effort=` with nothing after it would otherwise render a blank chip, which
    // is indistinguishable from a layout bug.
    expect(cursorModelEffort('some-model[effort=,fast=false]')).toBeNull();
  });
});

describe('splitCursorModelId', () => {
  it('splits a LEGACY composed id into a bare name and its parameters', () => {
    // The form every cursor chat created before the parameterized handshake
    // stored, and the form the agent now answers `-32602 Invalid params` to.
    expect(
      splitCursorModelId(
        'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      ),
    ).toEqual({
      model: 'claude-opus-5',
      parameters: [
        { id: 'thinking', value: 'true' },
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    });
  });

  it('passes a bare id through untouched', () => {
    // What the parameterized handshake reports, and what claude's aliases are.
    expect(splitCursorModelId('claude-opus-5')).toEqual({
      model: 'claude-opus-5',
      parameters: [],
    });
    expect(splitCursorModelId('opus')).toEqual({
      model: 'opus',
      parameters: [],
    });
  });

  it('reads an empty bracket as a name with no parameters', () => {
    // A real row: `gemini-3.1-pro[]` is offered exactly like that.
    expect(splitCursorModelId('gemini-3.1-pro[]')).toEqual({
      model: 'gemini-3.1-pro',
      parameters: [],
    });
  });

  it('answers null for no model at all — "leave the agent on its own"', () => {
    expect(splitCursorModelId(null)).toEqual({ model: null, parameters: [] });
    expect(splitCursorModelId(undefined)).toEqual({
      model: null,
      parameters: [],
    });
    expect(splitCursorModelId('   ')).toEqual({ model: null, parameters: [] });
  });

  it('degrades a malformed bracket instead of throwing', () => {
    // A stored id is user-visible state that predates this parser; a broken one
    // must cost the parameters it could not read, never the turn.
    expect(splitCursorModelId('m[effort=high,,broken,=x,y=]')).toEqual({
      model: 'm',
      parameters: [{ id: 'effort', value: 'high' }],
    });
    expect(splitCursorModelId('[effort=high]')).toEqual({
      model: null,
      parameters: [{ id: 'effort', value: 'high' }],
    });
  });
});

describe('cursorModelSelection', () => {
  it("lets the TURN's effort win over the one baked into a stored id", () => {
    // The whole feature on an existing chat: its id says `effort=high` because
    // that is what the account had months ago, and the composer now says xhigh.
    // Reverse this precedence and the picker cannot change anything on any chat
    // created before it existed.
    const selection = cursorModelSelection(
      'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      'xhigh',
    );

    expect(selection.model).toBe('claude-opus-5');
    expect(selection.parameters).toEqual([
      { id: 'thinking', value: 'true' },
      { id: 'context', value: '300k' },
      { id: 'fast', value: 'false' },
      // Appended LAST, and exactly once — the id's own effort is dropped rather
      // than left to be overwritten by frame order.
      { id: 'effort', value: 'xhigh' },
    ]);
  });

  it('carries an effort with no model, for a run on the CLI default', () => {
    // The ordinary case for a chat left on "default model". Requiring a model
    // here would make the picker inert for exactly those runs.
    expect(cursorModelSelection(null, 'max')).toEqual({
      model: null,
      parameters: [{ id: 'effort', value: 'max' }],
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
});
