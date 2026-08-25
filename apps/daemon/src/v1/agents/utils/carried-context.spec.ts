import { describe, expect, it } from 'vitest';

import { withCarriedContext } from './carried-context';

describe('withCarriedContext', () => {
  it('leaves the prompt alone when nothing is carried', () => {
    expect(withCarriedContext(null, 'what changed?')).toBe('what changed?');
  });

  it('treats a whitespace-only summary as nothing carried', () => {
    // A compaction that produced no words has nothing to hand over, and an
    // empty block would ASSERT that the agent's memory is empty — worse than
    // saying nothing, because the agent would act on it.
    expect(withCarriedContext('  \n\t ', 'what changed?')).toBe(
      'what changed?',
    );
  });

  it('carries the summary in a tagged block ABOVE the message', () => {
    const composed = withCarriedContext('we agreed on plan B', 'now do it');
    expect(composed).toContain('<compacted-conversation>');
    expect(composed).toContain('we agreed on plan B');
    expect(composed).toContain('</compacted-conversation>');
    // Order is the point: the record first, the person speaking last.
    expect(composed.indexOf('we agreed on plan B')).toBeLessThan(
      composed.indexOf('now do it'),
    );
    expect(composed.endsWith('now do it')).toBe(true);
  });

  it('says the block is memory rather than something the user just wrote', () => {
    // Without this sentence the first turn after a compaction reads as one
    // enormous user message, and the agent answers the summary instead of the
    // question under it.
    expect(withCarriedContext('history', 'question')).toContain(
      'not as something the user just wrote',
    );
  });
});
