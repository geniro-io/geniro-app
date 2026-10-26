import { describe, expect, it } from 'vitest';

import { CLAUDE_FAST_MODE_PARAMETER_ID } from '../claude.const';
import {
  fastModeParameter,
  isFastModeCapable,
  wantsFastMode,
} from './claude-fast-mode.utils';

describe('isFastModeCapable', () => {
  it('accepts the dated account-cache ids the CLI actually reports for Opus', () => {
    // Real ids observed off `~/.claude.json`'s picker cache and the CLI's own
    // `system/init` line (probed on 2.1.280) — never the exact `opus-4-8` /
    // `opus-5` pair the CLI's own gate checks, which is the point: those two
    // literals are what this function deliberately widens past.
    expect(isFastModeCapable('claude-opus-5-5')).toBe(true);
    expect(isFastModeCapable('claude-opus-5[1m]')).toBe(true);
  });

  it('accepts the bare tier alias, which the CLI’s own gate cannot name', () => {
    // `opus` always resolves to the latest Opus tier, so it has to pass this
    // check even though it contains neither `opus-4-8` nor `opus-5` — a
    // stricter substring pair would silently stop offering the toggle for a
    // chat configured with the alias itself.
    expect(isFastModeCapable('opus')).toBe(true);
  });

  it('refuses a non-Opus model', () => {
    expect(isFastModeCapable('claude-sonnet-5')).toBe(false);
    expect(isFastModeCapable('haiku')).toBe(false);
  });
});

describe('fastModeParameter', () => {
  it('carries the CLI’s own settings key as its id, untranslated', () => {
    const parameter = fastModeParameter();
    expect(parameter.id).toBe(CLAUDE_FAST_MODE_PARAMETER_ID);
    expect(parameter.values.map((v) => v.id)).toEqual(['true', 'false']);
  });
});

describe('wantsFastMode', () => {
  it('reads only an explicit ON as consent to opt in', () => {
    expect(wantsFastMode({ fastMode: 'true' })).toBe(true);
    expect(wantsFastMode({ fastMode: 'false' })).toBe(false);
    expect(wantsFastMode({})).toBe(false);
    expect(wantsFastMode(null)).toBe(false);
    expect(wantsFastMode(undefined)).toBe(false);
    expect(wantsFastMode({ fastMode: 'yes' })).toBe(false);
  });
});
