import { describe, expect, it } from 'vitest';

import { AUTO_FLAG_REFUSAL_STREAK } from '../chat.types';
import { flagsFirstSection } from './flags-first';

describe('flagsFirstSection', () => {
  it('tells the analysis how to tell geniro’s own flags from an agent’s', () => {
    const text = flagsFirstSection('period');

    expect(text).toContain(
      'A flag marked `automatic` was raised by geniro itself',
    );
    expect(text).toContain(
      `one refused ${AUTO_FLAG_REFUSAL_STREAK} times running in a conversation`,
    );
  });
});
