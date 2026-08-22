import { describe, expect, it } from 'vitest';

import type { AgentReportedCommand } from '../../adapter.types';
import {
  CLAUDE_COMMANDS_CHANGED_KEY,
  CLAUDE_COMMANDS_CHANGED_SUBTYPE,
  CLAUDE_RELOAD_COMMANDS_SUBTYPE,
} from '../claude.const';
import {
  readCommandsChanged,
  reloadCommandsRequestLine,
} from './claude-commands.utils';

describe('reloadCommandsRequestLine', () => {
  it('writes the reload subtype as a newline-terminated control request', () => {
    const line = reloadCommandsRequestLine('req-1');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: CLAUDE_RELOAD_COMMANDS_SUBTYPE },
    });
  });
});

describe('readCommandsChanged', () => {
  const envelope = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: 'system',
    subtype: CLAUDE_COMMANDS_CHANGED_SUBTYPE,
    [CLAUDE_COMMANDS_CHANGED_KEY]: [],
    ...over,
  });

  const cases: {
    name: string;
    input: unknown;
    expected: AgentReportedCommand[] | null;
  }[] = [
    {
      // A line that is not even an object — every other stdout line the
      // dialogue can produce falls here, and it must read as "not this
      // announcement" rather than throw.
      name: 'a non-object line answers null, not a thrown error',
      input: 'just some stdout noise',
      expected: null,
    },
    {
      name: 'a null line answers null the same way',
      input: null,
      expected: null,
    },
    {
      // Right shape, wrong subtype: an ordinary system line must not be
      // mistaken for the reload announcement.
      name: 'the wrong subtype answers null',
      input: envelope({ subtype: 'status' }),
      expected: null,
    },
    {
      // Right subtype, wrong `type` — the OTHER half of the same guard. A
      // line of some other type carrying this subtype by coincidence must
      // not be mistaken for the reload announcement either.
      name: 'the right subtype on a non-system type answers null',
      input: envelope({ type: 'assistant' }),
      expected: null,
    },
    {
      // A row that is not an object at all (a bare number, or null) is
      // skipped rather than crashing the loop — real rows around it still
      // surface.
      name: 'non-object rows are skipped, real rows still surface',
      input: envelope({
        [CLAUDE_COMMANDS_CHANGED_KEY]: [42, null, { name: 'ok' }],
      }),
      expected: [{ name: 'ok', description: null }],
    },
    {
      // The rows key exists but is not an array — a shape this CLI has never
      // been observed to send, and the reader must degrade rather than throw.
      name: 'a non-array rows value answers null',
      input: envelope({ [CLAUDE_COMMANDS_CHANGED_KEY]: { not: 'an array' } }),
      expected: null,
    },
    {
      // A row with no name at all is skipped — an entry with nothing to call
      // it cannot appear in the autocomplete list.
      name: 'a nameless row is dropped, not surfaced with an empty name',
      input: envelope({
        [CLAUDE_COMMANDS_CHANGED_KEY]: [{ description: 'has no name' }],
      }),
      expected: [],
    },
    {
      // A row whose description is an empty string is reported with `null`,
      // not `''` — the merge in the composer treats null as "no sentence yet"
      // and would otherwise let a blank beat a real description from the disk
      // scan.
      name: 'a blank description is reported as null, not an empty string',
      input: envelope({
        [CLAUDE_COMMANDS_CHANGED_KEY]: [{ name: 'compact', description: '' }],
      }),
      expected: [{ name: 'compact', description: null }],
    },
    {
      // The happy row: a real name paired with a real sentence.
      name: 'a real row keeps its name and description',
      input: envelope({
        [CLAUDE_COMMANDS_CHANGED_KEY]: [
          { name: 'compact', description: 'Compacts the conversation' },
        ],
      }),
      expected: [{ name: 'compact', description: 'Compacts the conversation' }],
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(readCommandsChanged(input)).toEqual(expected);
  });

  it('matches the wire subtype and key as claude actually sends them, not merely the constant', () => {
    // Every case above builds through `envelope()`, which sources `type`,
    // `subtype` and the rows key from the SAME constants the reader imports
    // — so renaming CLAUDE_COMMANDS_CHANGED_SUBTYPE/_KEY would keep the whole
    // table green while the reader silently stopped matching claude's real
    // `system/commands_changed` line. This spells the values as literally
    // observed on the wire (see the probe notes beside the constants in
    // claude.const.ts) so a rename of either constant actually breaks it.
    const wireLine = {
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'compact', description: 'Compacts the conversation' }],
    };
    expect(readCommandsChanged(wireLine)).toEqual([
      { name: 'compact', description: 'Compacts the conversation' },
    ]);
  });
});
