import { describe, expect, it } from 'vitest';

import type { AcpEndedDelegate } from '../../acp/acp-driver';
import { cursorDelegateWakePrompt } from './cursor-delegate-wake.utils';

const ended = (over: Partial<AcpEndedDelegate> = {}): AcpEndedDelegate => ({
  label: 'Bugs review',
  outcome: 'completed',
  durationMs: 192_000,
  finalText: 'Found 2 bugs.',
  recordPath: '/home/.cursor/projects/x/agent-transcripts/a/a.jsonl',
  ...over,
});

describe('cursorDelegateWakePrompt', () => {
  it('names each delegate, how it ended, its report and its transcript', () => {
    const text = cursorDelegateWakePrompt([
      ended(),
      ended({
        label: 'Security review',
        outcome: 'failed',
        durationMs: 5_000,
        finalText: null,
      }),
    ]);

    expect(text).toContain('Your 2 background sub-agents have finished.');
    expect(text).toContain('## Bugs review — finished after 3m 12s');
    expect(text).toContain('Found 2 bugs.');
    expect(text).toContain(
      'Transcript: /home/.cursor/projects/x/agent-transcripts/a/a.jsonl',
    );
    expect(text).toContain('## Security review — failed after 5s');
    expect(text).toContain('(It left no final report.)');
  });

  it('says how an ending is not known rather than guessing one', () => {
    expect(
      cursorDelegateWakePrompt([
        ended({
          outcome: null,
          durationMs: null,
          finalText: null,
          label: null,
        }),
      ]),
    ).toContain('## Sub-agent 1 — ended (its transcript could not be read');
  });

  it('cuts a long report and points at the transcript for the rest', () => {
    const text = cursorDelegateWakePrompt([
      ended({ finalText: `${'x'.repeat(30_000)}TAIL-MARKER` }),
    ]);

    expect(text).not.toContain('TAIL-MARKER');
    expect(text).toContain(
      '[… cut here — the rest is in the transcript above]',
    );
  });

  it('bounds the reports of a wide fan-out together, not only one by one', () => {
    const text = cursorDelegateWakePrompt(
      Array.from({ length: 10 }, (_, index) =>
        ended({ label: `Reviewer ${index}`, finalText: 'y'.repeat(19_000) }),
      ),
    );

    expect(text.length).toBeLessThan(90_000);
    // Every delegate is still NAMED, even past the budget.
    expect(text).toContain('## Reviewer 9 — finished');
  });
});
