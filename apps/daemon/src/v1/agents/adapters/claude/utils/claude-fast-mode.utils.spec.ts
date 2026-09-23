import { describe, expect, it } from 'vitest';

import {
  CLAUDE_FAST_MODE_PARAMETER_ID,
  CLAUDE_SETTINGS_FLAG,
} from '../claude.const';
import {
  fastModeArgs,
  fastModeParameter,
  isFastModeCapable,
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

describe('fastModeArgs', () => {
  it('passes --settings only when the parameter is explicitly ON', () => {
    // The real observable a false pin would miss: not merely "some argv
    // appears", but the EXACT flag and JSON payload the CLI reads its opt-in
    // from (probe-verified — see `CLAUDE_SETTINGS_FLAG`'s doc block: omitting
    // it reports `fast_mode_disabled_reason: "sdk_opt_in_required"`).
    expect(fastModeArgs({ fastMode: 'true' })).toEqual([
      CLAUDE_SETTINGS_FLAG,
      '{"fastMode":true}',
    ]);
  });

  it('omits the flag for every other value, including an explicit OFF', () => {
    expect(fastModeArgs({ fastMode: 'false' })).toEqual([]);
    expect(fastModeArgs({})).toEqual([]);
    expect(fastModeArgs(null)).toEqual([]);
    expect(fastModeArgs(undefined)).toEqual([]);
    // A stray or malformed value must not be read as consent to opt in.
    expect(fastModeArgs({ fastMode: 'yes' })).toEqual([]);
  });
});
