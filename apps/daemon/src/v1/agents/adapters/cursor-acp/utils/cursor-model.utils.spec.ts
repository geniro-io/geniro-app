import { describe, expect, it } from 'vitest';

import { cursorModelEffort } from './cursor-model.utils';

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
