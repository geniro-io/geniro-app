import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../../../__tests__/temp-dir';
import type { AgentModel } from '../../adapter.types';
import { ClaudeAdapter } from '../claude.adapter';
import { claudeModels, readClaudeModelCache } from './claude-models.utils';

/**
 * The alias floor the adapter ACTUALLY SHIPS. Read off `config.builtinModels`
 * — the declared fallback surface `listModels` passes in — rather than off a
 * const, so these cases pin what a real install's picker is floored with.
 */
const shippedFloor: readonly AgentModel[] = new ClaudeAdapter().getConfig()
  .builtinModels;

const withClaudeJson = (contents: string): string => {
  const home = tempDir('claude-home-');
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

  it('drops an entry the CLI marked disabled', () => {
    // Verbatim from a real 2.1.251 profile (2026-09-03). The CLI files
    // placeholders in this list to EXPLAIN a model the install cannot run:
    // `cc-update-required-1` is a sentinel, not a model id, and offering it
    // sent `--model cc-update-required-1` on every turn of the chat that
    // picked it.
    const home = withClaudeJson(
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'claude-fable-5[1m]', label: 'Fable' },
          {
            value: 'cc-update-required-1',
            label: 'Fable 5.1 (disabled)',
            description: 'Update to 2.1.255+ to use Fable 5.1',
            disabled: true,
          },
        ],
      }),
    );

    expect(readClaudeModelCache(home)).toEqual([
      { id: 'claude-fable-5[1m]', label: 'Fable', source: 'cli' },
    ]);
  });

  it('keeps a model whose `disabled` is anything but true', () => {
    // The drop hides a row the user can see, so an unfamiliar shape must fall
    // the safe way — listing a model the CLI would have accepted.
    const home = withClaudeJson(
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'a-1', label: 'A', disabled: false },
          { value: 'b-1', label: 'B', disabled: 'true' },
          { value: 'c-1', label: 'C' },
        ],
      }),
    );

    expect(readClaudeModelCache(home).map((model) => model.id)).toEqual([
      'a-1',
      'b-1',
      'c-1',
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
    expect(readClaudeModelCache(tempDir('no-file-'))).toEqual([]);
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

    expect(claudeModels(shippedFloor, home).map((model) => model.id)).toEqual([
      'fable-x',
      'opus',
      'sonnet',
      'haiku',
    ]);
  });

  it('still offers the aliases when the cache is empty or unreadable', () => {
    // The aliases resolve to the latest model of each tier, so an install that
    // has never populated the cache still gets a working picker.
    const home = tempDir('claude-empty-');

    expect(claudeModels(shippedFloor, home)).toEqual([
      { id: 'opus', label: 'opus', source: 'builtin' },
      { id: 'sonnet', label: 'sonnet', source: 'builtin' },
      { id: 'haiku', label: 'haiku', source: 'builtin' },
    ]);
  });

  it('floors the list with the set it is GIVEN, not the shipped aliases', () => {
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

    expect(claudeModels(shippedFloor, home).map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});
