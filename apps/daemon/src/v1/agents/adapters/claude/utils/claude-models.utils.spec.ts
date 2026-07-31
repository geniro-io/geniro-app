import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentModel } from '../../adapter.types';
import { CLAUDE_BUILTIN_MODELS } from '../claude.const';
import { claudeModels, readClaudeModelCache } from './claude-models.utils';

const withClaudeJson = (contents: string): string => {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
  writeFileSync(join(home, '.claude.json'), contents);
  return home;
};

describe('readClaudeModelCache', () => {
  it('reads the account models the CLI cached for its own picker', () => {
    // claude has NO list-models subcommand, so this cache is the only live
    // source of account-specific models — the ones a hardcoded list can never
    // know about.
    const home = withClaudeJson(
      JSON.stringify({
        additionalModelOptionsCache: [
          {
            value: 'claude-fable-5[1m]',
            label: 'Fable',
            description: 'Most capable',
          },
        ],
      }),
    );

    expect(readClaudeModelCache(home)).toEqual([
      { id: 'claude-fable-5[1m]', label: 'Fable', source: 'cli' },
    ]);
  });

  it('falls back to the id when an entry carries no label', () => {
    const home = withClaudeJson(
      JSON.stringify({ additionalModelOptionsCache: [{ value: 'x-1' }] }),
    );

    expect(readClaudeModelCache(home)).toEqual([
      { id: 'x-1', label: 'x-1', source: 'cli' },
    ]);
  });

  it('survives every shape this undocumented file could take', () => {
    // It is claude's internal state, not an API: a shape change must degrade
    // to the built-in aliases, never throw or list junk.
    expect(
      readClaudeModelCache(mkdtempSync(join(tmpdir(), 'no-file-'))),
    ).toEqual([]);
    expect(readClaudeModelCache(withClaudeJson('{ not json'))).toEqual([]);
    expect(readClaudeModelCache(withClaudeJson('"a string"'))).toEqual([]);
    expect(
      readClaudeModelCache(
        withClaudeJson(JSON.stringify({ additionalModelOptionsCache: {} })),
      ),
    ).toEqual([]);
    expect(
      readClaudeModelCache(
        withClaudeJson(
          JSON.stringify({
            additionalModelOptionsCache: [null, 42, {}, { value: 7 }],
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe('claudeModels', () => {
  it('offers the cached account models ahead of the documented aliases', () => {
    const home = withClaudeJson(
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'fable-x', label: 'Fable' }],
      }),
    );

    expect(
      claudeModels(CLAUDE_BUILTIN_MODELS, home).map((model) => model.id),
    ).toEqual(['fable-x', 'opus', 'sonnet', 'haiku']);
  });

  it('still offers the aliases when the cache is empty or unreadable', () => {
    // The aliases resolve to the latest model of each tier, so an install that
    // has never populated the cache still gets a working picker.
    const home = mkdtempSync(join(tmpdir(), 'claude-empty-'));

    expect(claudeModels(CLAUDE_BUILTIN_MODELS, home)).toEqual([
      { id: 'opus', label: 'opus', source: 'builtin' },
      { id: 'sonnet', label: 'sonnet', source: 'builtin' },
      { id: 'haiku', label: 'haiku', source: 'builtin' },
    ]);
  });

  it('floors the list with the set it is GIVEN, not the const next door', () => {
    // The floor is a parameter precisely so `config.builtinModels` can be the
    // one declared fallback surface: hand it a different set and NONE of the
    // shipped aliases may appear.
    const home = withClaudeJson(
      JSON.stringify({ additionalModelOptionsCache: [{ value: 'fable-x' }] }),
    );
    const floor: readonly AgentModel[] = [
      { id: 'given-floor-model', label: 'Given floor', source: 'builtin' },
    ];

    expect(claudeModels(floor, home).map((model) => model.id)).toEqual([
      'fable-x',
      'given-floor-model',
    ]);
  });

  it('does not list a model twice when the cache repeats an alias', () => {
    const home = withClaudeJson(
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'opus', label: 'Opus (cached)' },
        ],
      }),
    );

    expect(
      claudeModels(CLAUDE_BUILTIN_MODELS, home).map((model) => model.id),
    ).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
