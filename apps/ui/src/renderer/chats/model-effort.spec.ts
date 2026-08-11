import { describe, expect, it } from 'vitest';

import { parseModelEffort } from './model-effort';

describe('parseModelEffort', () => {
  it('reads effort out of a cursor ACP model id', () => {
    expect(
      parseModelEffort(
        'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
      ),
    ).toBe('high');
  });

  it('returns null when the id carries no effort parameter', () => {
    expect(parseModelEffort('gpt-5')).toBeNull();
    expect(parseModelEffort('claude-opus-5[thinking=true]')).toBeNull();
  });
});
