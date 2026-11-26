import { describe, expect, it } from 'vitest';

import {
  applyArgSynonyms,
  clampCount,
  leadWithCall,
  withSynonymProperties,
} from './tool-arg-synonyms';

describe('applyArgSynonyms', () => {
  const synonyms = { monitor: 'id', monitor_id: 'id' };

  it('renames a synonym to the name the tool reads and keeps the other arguments', () => {
    expect(applyArgSynonyms({ monitor: 'm1', limit: 5 }, synonyms)).toEqual({
      ok: true,
      args: { id: 'm1', limit: 5 },
    });
  });

  it('accepts a duplicate that agrees with the name it stands for', () => {
    expect(applyArgSynonyms({ id: 'm1', monitor: 'm1' }, synonyms)).toEqual({
      ok: true,
      args: { id: 'm1' },
    });
    expect(
      applyArgSynonyms({ monitor: 'm1', monitor_id: 'm1' }, synonyms),
    ).toEqual({ ok: true, args: { id: 'm1' } });
  });

  it('refuses a duplicate that disagrees, naming both names', () => {
    expect(applyArgSynonyms({ id: 'm1', monitor: 'm2' }, synonyms)).toEqual({
      ok: false,
      error:
        'send id once — id and monitor name the same argument and disagree',
    });
    expect(
      applyArgSynonyms({ monitor: 'm1', monitor_id: 'm2' }, synonyms),
    ).toEqual({
      ok: false,
      error:
        'send id once — monitor and monitor_id name the same argument and disagree',
    });
  });

  it('ignores a null synonym beside the name it stands for, in either order', () => {
    expect(applyArgSynonyms({ id: 'm1', monitor: null }, synonyms)).toEqual({
      ok: true,
      args: { id: 'm1', monitor: null },
    });
    expect(applyArgSynonyms({ monitor: null, id: 'm1' }, synonyms)).toEqual({
      ok: true,
      args: { monitor: null, id: 'm1' },
    });
  });

  it('reads a null name as absent, so a synonym sent with it is the value', () => {
    expect(applyArgSynonyms({ id: null, monitor: 'm1' }, synonyms)).toEqual({
      ok: true,
      args: { id: 'm1' },
    });
    expect(applyArgSynonyms({ monitor: 'm1', id: null }, synonyms)).toEqual({
      ok: true,
      args: { id: 'm1' },
    });
  });

  it('reads an argument named like an Object prototype member as itself, not as a synonym', () => {
    expect(
      applyArgSynonyms({ constructor: 'x', monitor: 'm1' }, synonyms),
    ).toEqual({ ok: true, args: { constructor: 'x', id: 'm1' } });
    expect(applyArgSynonyms({ toString: 'x' }, synonyms)).toEqual({
      ok: true,
      args: { toString: 'x' },
    });
  });
});

describe('withSynonymProperties', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The monitor.' },
      limit: { type: 'number', description: 'How many.' },
    },
    required: ['id'],
    additionalProperties: false,
  };

  it('declares each synonym right after the name it stands for', () => {
    const declared = withSynonymProperties(schema, {
      monitor: 'id',
      monitor_id: 'id',
      max: 'limit',
    });

    expect(Object.keys(declared.properties as object)).toEqual([
      'id',
      'monitor',
      'monitor_id',
      'limit',
      'max',
    ]);
    expect((declared.properties as Record<string, unknown>).monitor).toEqual({
      type: 'string',
      description: 'Same as `id` — send one of them.',
    });
  });

  it('drops a required target and says one of its synonyms is required', () => {
    const declared = withSynonymProperties(schema, { monitor: 'id' });

    expect(declared.required).toBeUndefined();
    expect(
      (declared.properties as Record<string, { description: string }>).id!
        .description,
    ).toBe('The monitor. Required (or one of `monitor`).');
  });

  it('keeps the required names no synonym stands for', () => {
    const declared = withSynonymProperties(
      { ...schema, required: ['id', 'limit'] },
      { monitor: 'id' },
    );

    expect(declared.required).toEqual(['limit']);
  });

  it('leaves a target that is not required as it was', () => {
    const declared = withSynonymProperties(
      { ...schema, required: [] },
      { monitor: 'id' },
    );

    expect((declared.properties as Record<string, unknown>).id).toEqual(
      schema.properties.id,
    );
    expect(declared.required).toBeUndefined();
  });
});

describe('clampCount', () => {
  it('reads a count past the maximum as the maximum', () => {
    expect(clampCount({ limit: 250, query: 'x' }, 'limit', 200)).toEqual({
      limit: 200,
      query: 'x',
    });
  });

  it('leaves a count within the maximum, a missing one and a non-number as they are', () => {
    expect(clampCount({ limit: 200 }, 'limit', 200)).toEqual({ limit: 200 });
    expect(clampCount({ query: 'x' }, 'limit', 200)).toEqual({ query: 'x' });
    expect(clampCount({ limit: '250' }, 'limit', 200)).toEqual({
      limit: '250',
    });
  });
});

describe('leadWithCall', () => {
  it('puts the right call on its own first line, then the reason', () => {
    expect(leadWithCall('call x({})', 'name is wrong')).toBe(
      'call x({})\nname is wrong',
    );
  });
});
