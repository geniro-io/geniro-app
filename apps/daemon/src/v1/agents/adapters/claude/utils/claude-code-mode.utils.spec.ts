import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_MODE_PARAMETER_ID } from '../claude.const';
import {
  codeModeModelRefusal,
  codeModeParameter,
  codeModeRouteRefusal,
  codeModeVersionRefusal,
  wantsCodeMode,
} from './claude-code-mode.utils';

describe('codeModeParameter', () => {
  it('offers On and Off, reads Off by default and is fixed per session', () => {
    const parameter = codeModeParameter(null);
    expect(parameter.id).toBe(CLAUDE_CODE_MODE_PARAMETER_ID);
    expect(parameter.values.map((value) => value.id)).toEqual([
      'true',
      'false',
    ]);
    expect(parameter.current).toBe('false');
    expect(parameter.fixedPerSession).toBe(true);
    expect(parameter).not.toHaveProperty('unavailableReason');
  });

  it('carries the reason it cannot run', () => {
    expect(codeModeParameter('too old').unavailableReason).toBe('too old');
  });
});

describe('wantsCodeMode', () => {
  it('reads only an explicit ON', () => {
    expect(wantsCodeMode({ codeMode: 'true' })).toBe(true);
    expect(wantsCodeMode({ codeMode: 'false' })).toBe(false);
    expect(wantsCodeMode({ fastMode: 'true' })).toBe(false);
    expect(wantsCodeMode(null)).toBe(false);
  });
});

describe('codeModeVersionRefusal', () => {
  it('accepts 2.1.330 and later', () => {
    expect(codeModeVersionRefusal('2.1.330 (Claude Code)')).toBeNull();
    expect(codeModeVersionRefusal('2.1.400 (Claude Code)')).toBeNull();
    expect(codeModeVersionRefusal('2.2.0')).toBeNull();
    expect(codeModeVersionRefusal('3.0.1')).toBeNull();
  });

  it('refuses an older build, naming both versions', () => {
    expect(codeModeVersionRefusal('2.1.327 (Claude Code)')).toBe(
      'Code mode needs Claude Code 2.1.330 or later; this one is 2.1.327',
    );
    expect(codeModeVersionRefusal('2.0.999')).not.toBeNull();
    expect(codeModeVersionRefusal('1.9.500')).not.toBeNull();
  });

  it('does not refuse a version it cannot read', () => {
    expect(codeModeVersionRefusal(null)).toBeNull();
    expect(codeModeVersionRefusal('unknown')).toBeNull();
  });
});

describe('codeModeModelRefusal', () => {
  it('accepts 5.5 and later models and the tier aliases', () => {
    for (const model of [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5[1m]',
      'claude-opus-6',
      'claude-sonnet-5-7',
      'opus',
      'sonnet',
      'haiku',
      'default',
    ]) {
      expect(codeModeModelRefusal(model), model).toBeNull();
    }
  });

  it('refuses a model older than 5.5, whatever its naming style', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-opus-4-20250514',
      'claude-sonnet-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
    ]) {
      expect(codeModeModelRefusal(model), model).not.toBeNull();
    }
  });

  it('leaves a name with no recognisable generation to the CLI', () => {
    expect(codeModeModelRefusal('my-custom-model')).toBeNull();
  });
});

describe('codeModeRouteRefusal', () => {
  it('accepts Anthropic’s own endpoint', () => {
    expect(codeModeRouteRefusal({}, false)).toBeNull();
    expect(
      codeModeRouteRefusal(
        { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: '' },
        false,
      ),
    ).toBeNull();
  });

  it('refuses a local model, a custom base URL and a third-party provider', () => {
    expect(codeModeRouteRefusal({}, true)).toMatch(/local models/);
    expect(
      codeModeRouteRefusal(
        { ANTHROPIC_BASE_URL: 'https://proxy.example' },
        false,
      ),
    ).toMatch(/ANTHROPIC_BASE_URL/);
    expect(
      codeModeRouteRefusal({ CLAUDE_CODE_USE_VERTEX: '1' }, false),
    ).toMatch(/Vertex/);
  });
});
