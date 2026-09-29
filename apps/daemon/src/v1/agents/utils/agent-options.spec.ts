import { describe, expect, it } from 'vitest';

import {
  readAgentOptions,
  sanitizeAgentOptions,
  writeAgentOptions,
} from './agent-options';

describe('agent options column', () => {
  it('round-trips a snapshot, OFF values included', () => {
    const snapshot = {
      'cursor-agent': { maxMode: false },
      claude: { browserTools: true },
    };

    expect(readAgentOptions(writeAgentOptions(snapshot))).toEqual(snapshot);
  });

  it('stores an empty snapshot as null, so "said nothing" is one state', () => {
    expect(writeAgentOptions({})).toBeNull();
    expect(writeAgentOptions(undefined)).toBeNull();
    expect(writeAgentOptions({ claude: {} })).toBeNull();
  });

  it('reads an unreadable column as no switches rather than throwing', () => {
    // A throw here would fail every read of the chat; an empty snapshot costs
    // only the switches, which then read their declared defaults.
    expect(readAgentOptions(null)).toEqual({});
    expect(readAgentOptions('  ')).toEqual({});
    expect(readAgentOptions('not json{')).toEqual({});
    expect(readAgentOptions('[1,2]')).toEqual({});
  });

  it('keeps only boolean values under clean keys', () => {
    expect(
      sanitizeAgentOptions({
        claude: {
          browserTools: true,
          count: 3,
          label: 'yes',
          ' spaced ': false,
          ['bad\u0000id']: true,
        },
        ['x'.repeat(200)]: { maxMode: true },
        'cursor-agent': 'not a map',
      }),
    ).toEqual({ claude: { browserTools: true, spaced: false } });
  });
});
