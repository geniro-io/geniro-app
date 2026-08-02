import { describe, expect, it } from 'vitest';

import type { AgentModel } from '../../adapter.types';
import { CursorAdapter } from '../cursor.adapter';
import { parseCursorModels } from './cursor-models.utils';

/**
 * The fallback set the adapter ACTUALLY SHIPS. Read off `config.builtinModels`
 * — the declared floor `listModels` falls back to when the CLI cannot be asked
 * — rather than off a const, so these cases pin what a real install's picker
 * offers.
 */
const shippedFallback: readonly AgentModel[] = new CursorAdapter().getConfig()
  .builtinModels;

describe('parseCursorModels', () => {
  it('reads one id per line, as `cursor-agent models` prints them', () => {
    const models = parseCursorModels(
      'gpt-5.2-high\nclaude-4.6-opus-high\ngemini-3-pro\n',
    );

    expect(models).toEqual([
      { id: 'gpt-5.2-high', label: 'gpt-5.2-high', source: 'cli' },
      {
        id: 'claude-4.6-opus-high',
        label: 'claude-4.6-opus-high',
        source: 'cli',
      },
      { id: 'gemini-3-pro', label: 'gemini-3-pro', source: 'cli' },
    ]);
  });

  it('keeps compound ids VERBATIM rather than deriving a base id', () => {
    // The ids flatten model × reasoning effort and the families are spelled
    // inconsistently (`claude-4.6-opus` beside `claude-opus-4-8`), so
    // stripping a suffix here would invent ids the CLI may reject. Only
    // cursor knows what `--model` honours.
    const models = parseCursorModels('claude-opus-4-8-thinking-high');

    expect(models?.[0]?.id).toBe('claude-opus-4-8-thinking-high');
  });

  it('drops the per-session tags cursor appends to a row', () => {
    const models = parseCursorModels('gpt-5.2 (current)\nsonnet-4.6 (default)');

    expect(models?.map((model) => model.id)).toEqual(['gpt-5.2', 'sonnet-4.6']);
  });

  it('ignores blanks, comments and a heading line', () => {
    const models = parseCursorModels('Available models:\n\n# note\ngpt-5\n');

    expect(models?.map((model) => model.id)).toEqual(['gpt-5']);
  });

  it('de-dupes repeated ids', () => {
    expect(parseCursorModels('gpt-5\ngpt-5')?.length).toBe(1);
  });

  it('reports "could not be asked" for the unauthenticated notice', () => {
    // Null (not an empty list) is what makes the caller fall back — treating
    // this as an answer would leave the picker with no models at all.
    expect(
      parseCursorModels('No models available for this account.'),
    ).toBeNull();
  });

  it('reports "could not be asked" for empty or absent output', () => {
    // An install too old for the `models` subcommand treats it as a PROMPT and
    // drops into sign-in, so the command times out and stdout is null.
    expect(parseCursorModels(null)).toBeNull();
    expect(parseCursorModels('   \n  ')).toBeNull();
  });

  it('offers the documented example ids as the fallback set', () => {
    // These are the ids cursor-agent's own `--model` help gives, so they are
    // the only ones documented to work without asking the account.
    expect(shippedFallback.map((model) => model.id)).toEqual([
      'gpt-5',
      'sonnet-4',
      'sonnet-4-thinking',
    ]);
    expect(shippedFallback.every((model) => model.source === 'builtin')).toBe(
      true,
    );
  });
});
