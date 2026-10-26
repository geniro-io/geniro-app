import { describe, expect, it } from 'vitest';

import { CLAUDE_SETTINGS_FLAG } from '../claude.const';
import { claudeSettingsArgs } from './claude-settings.utils';

function settingsOf(args: string[]): Record<string, unknown> {
  expect(args[0]).toBe(CLAUDE_SETTINGS_FLAG);
  expect(args).toHaveLength(2);
  return JSON.parse(args[1]!) as Record<string, unknown>;
}

describe('claudeSettingsArgs', () => {
  it('sends nothing when the turn has nothing to set', () => {
    expect(claudeSettingsArgs({})).toEqual([]);
    expect(
      claudeSettingsArgs({
        modelParameters: { fastMode: 'false' },
        replyLanguage: '  ',
      }),
    ).toEqual([]);
  });

  it('carries fast mode only when it is explicitly ON', () => {
    expect(
      settingsOf(claudeSettingsArgs({ modelParameters: { fastMode: 'true' } })),
    ).toEqual({ fastMode: true });
  });

  it('carries the reply language under the CLI’s own key, trimmed', () => {
    expect(
      settingsOf(claudeSettingsArgs({ replyLanguage: ' Russian ' })),
    ).toEqual({ language: 'Russian' });
  });

  it('puts fast mode and the language in ONE flag, since a second would replace the first', () => {
    expect(
      settingsOf(
        claudeSettingsArgs({
          modelParameters: { fastMode: 'true' },
          replyLanguage: 'Russian',
        }),
      ),
    ).toEqual({ fastMode: true, language: 'Russian' });
  });

  it('folds an Ollama env in only when something else is being set', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' };
    expect(
      settingsOf(claudeSettingsArgs({ replyLanguage: 'Russian', env })),
    ).toEqual({ language: 'Russian', env });
    // With nothing else to say, the base's own `--settings {"env"}` stands.
    expect(claudeSettingsArgs({ env })).toEqual([]);
  });
});
