import { describe, expect, it } from 'vitest';

import { readModelParameters, writeModelParameters } from './model-parameters';

describe('model parameters column', () => {
  it('round-trips a map, and stores an empty one as NULL', () => {
    // One state in the row for "no parameters", not two — a `'{}'` and a null
    // would read the same everywhere and differ in every equality check.
    const stored = writeModelParameters({ optimize_for: 'intelligence' });
    expect(readModelParameters(stored)).toEqual({
      optimize_for: 'intelligence',
    });
    expect(writeModelParameters({})).toBeNull();
    expect(writeModelParameters(null)).toBeNull();
    expect(readModelParameters(null)).toEqual({});
  });

  it('answers an unreadable column with no parameters rather than throwing', () => {
    // Lenient on purpose: these are settings for the NEXT turn, and a row that
    // cannot be parsed must cost the user their picks, not their conversation.
    // A throw here fails every read of the chat.
    expect(readModelParameters('{not json')).toEqual({});
    expect(readModelParameters('["a","b"]')).toEqual({});
    expect(readModelParameters('"just a string"')).toEqual({});
    expect(readModelParameters('   ')).toEqual({});
  });

  it('drops entries that could never be sent as a config option', () => {
    // Both halves must be non-empty strings: the id names the option and the
    // value is what a turn sets it to, so neither has a meaningful blank form.
    // A non-string value is what a hand-edited row (or another build) produces.
    expect(
      readModelParameters(
        JSON.stringify({
          optimize_for: 'cost',
          '': 'orphan',
          blank: '   ',
          numeric: 3,
          nested: { a: 1 },
        }),
      ),
    ).toEqual({ optimize_for: 'cost' });
  });

  it('bounds what one run may carry, in count and in length', () => {
    // These ride a config option on EVERY turn for the life of the chat, which
    // is what makes the ceiling worth having at all.
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`p${i}`, 'v']),
    );
    expect(Object.keys(readModelParameters(JSON.stringify(many)))).toHaveLength(
      32,
    );
    expect(
      readModelParameters(JSON.stringify({ big: 'x'.repeat(201) })),
    ).toEqual({});
  });
});
