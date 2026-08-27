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

  it('bounds the parameter ID, not only its value', () => {
    // The count and the value cap between them left the KEY unbounded, and a
    // workflow arriving as YAML the user hand-edited or received is free to
    // supply one — it is then persisted to the run and rides every turn's
    // config frame for the life of that run.
    expect(
      readModelParameters(JSON.stringify({ ['k'.repeat(129)]: 'v' })),
    ).toEqual({});
    // …and the bound is generous enough that no real id trips it: the longest
    // this app has seen is `optimize_for`.
    expect(
      readModelParameters(JSON.stringify({ ['k'.repeat(128)]: 'v' })),
    ).toEqual({ ['k'.repeat(128)]: 'v' });
  });

  it('refuses a C0 control character in either half', () => {
    // The parallel this module's doc block draws to `CustomInstructionsSchema`
    // only holds with this — and it holds literally, because the refusal IS
    // that schema's own `hasControlCharacters` rather than a second reading of
    // what a control character is. Written as ESCAPES, never as the raw byte:
    // a NUL in a `.ts` file makes git classify the blob as binary, and the
    // repo's own pre-commit hook refuses such a file.
    expect(readModelParameters(JSON.stringify({ 'a\u0000b': 'v' }))).toEqual(
      {},
    );
    expect(readModelParameters(JSON.stringify({ ok: 'a\u001fb' }))).toEqual({});
    // Tab, newline and carriage return are that helper's deliberate exemptions
    // — ordinary in the prose it was written for. Kept rather than tightened
    // here: a second, stricter definition of "control character" is exactly the
    // drift that reusing one helper avoids.
    expect(readModelParameters(JSON.stringify({ ok: 'a\tb' }))).toEqual({
      ok: 'a\tb',
    });
    // A neighbouring GOOD entry still survives — one bad key must not cost the
    // user the rest of their picks.
    expect(
      readModelParameters(JSON.stringify({ 'a\u0000b': 'v', fine: 'yes' })),
    ).toEqual({ fine: 'yes' });
  });
});
