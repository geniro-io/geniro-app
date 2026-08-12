import { describe, expect, it } from 'vitest';

import { compactionDetail, compactionFacts } from './compaction-payload';

describe('compactionFacts', () => {
  it('reads the figures the daemon stamped', () => {
    expect(
      compactionFacts({
        message: 'This session is being continued…',
        origin: 'cli',
        compaction: { preTokens: 200_167, postTokens: 34_120 },
      }),
    ).toEqual({ preTokens: 200_167, postTokens: 34_120 });
  });

  it('is the MARKER, so a summary reported with no figures is still one', () => {
    // The boundary is optional metadata on the wire. Reading "no numbers" as
    // "not a compaction" would put the wall of prose back in the transcript.
    expect(
      compactionFacts({
        message: 'summary',
        origin: 'cli',
        compaction: { preTokens: null, postTokens: null },
      }),
    ).toEqual({ preTokens: null, postTokens: null });
  });

  it('is null for a relayed notice that is not a compaction summary', () => {
    expect(compactionFacts({ message: 'notice', origin: 'cli' })).toBeNull();
    expect(compactionFacts(null)).toBeNull();
    expect(compactionFacts({ compaction: 'yes' })).toBeNull();
  });

  it('rejects a non-positive count rather than showing "0 tokens"', () => {
    expect(
      compactionFacts({ compaction: { preTokens: 0, postTokens: -5 } }),
    ).toEqual({ preTokens: null, postTokens: null });
  });
});

describe('compactionDetail', () => {
  it('states the drop when both halves are known', () => {
    expect(compactionDetail({ preTokens: 200_167, postTokens: 34_120 })).toBe(
      '200.2k → 34.1k tokens',
    );
  });

  it('never subtracts across a missing operand', () => {
    // claude 2.1.228 sends pre_tokens on every boundary and post_tokens only
    // sometimes. An invented "after" figure is the one number a reader would act
    // on, so each of these says only what the CLI actually reported.
    expect(compactionDetail({ preTokens: 200_167, postTokens: null })).toBe(
      '200.2k tokens summarised',
    );
    expect(compactionDetail({ preTokens: null, postTokens: 34_120 })).toBe(
      '34.1k tokens after compacting',
    );
  });

  it('is undefined when the CLI reported nothing, so the row shows no figures', () => {
    expect(
      compactionDetail({ preTokens: null, postTokens: null }),
    ).toBeUndefined();
  });
});
