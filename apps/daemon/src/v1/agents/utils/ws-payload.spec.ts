import { describe, expect, it } from 'vitest';

import { extractStringField } from './ws-payload';

describe('extractStringField', () => {
  it('accepts the bare-string form', () => {
    expect(extractStringField('run-1', 'runId')).toBe('run-1');
  });

  it('accepts the object form keyed by the given field', () => {
    expect(extractStringField({ runId: 'run-1' }, 'runId')).toBe('run-1');
    expect(extractStringField({ terminalId: 't-1' }, 'terminalId')).toBe('t-1');
  });

  it('rejects empty, missing, and non-string values', () => {
    expect(extractStringField('', 'runId')).toBeNull();
    expect(extractStringField({ runId: '' }, 'runId')).toBeNull();
    expect(extractStringField({ other: 'x' }, 'runId')).toBeNull();
    expect(extractStringField({ runId: 42 }, 'runId')).toBeNull();
    expect(extractStringField(null, 'runId')).toBeNull();
    expect(extractStringField(undefined, 'runId')).toBeNull();
  });
});
