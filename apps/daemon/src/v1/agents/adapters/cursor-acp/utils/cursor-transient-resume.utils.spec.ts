import { describe, expect, it } from 'vitest';

import type { AcpEndedDelegate } from '../../acp/acp-driver';
import { CURSOR_TRANSIENT_RESUME_PROMPT } from '../cursor-acp.const';
import { cursorTransientResumePrompt } from './cursor-transient-resume.utils';

const finished = (over: Partial<AcpEndedDelegate> = {}): AcpEndedDelegate => ({
  label: 'Verify parent crumb',
  outcome: 'completed',
  durationMs: null,
  finalText: 'validation: refuted',
  recordPath: '/home/.cursor/projects/x/agent-transcripts/a/a.jsonl',
  ...over,
});

describe('cursorTransientResumePrompt', () => {
  it('is the plain continuation when the request caught no sub-agent', () => {
    expect(
      cursorTransientResumePrompt({ stillRunning: [], finished: [] }),
    ).toBe(CURSOR_TRANSIENT_RESUME_PROMPT);
  });

  it('tells the agent not to relaunch the sub-agents still running', () => {
    const text = cursorTransientResumePrompt({
      stillRunning: [{ label: 'Verify page-header findings' }, { label: null }],
      finished: [],
    });

    expect(text).toContain(
      '2 sub-agents you were waiting on are STILL RUNNING',
    );
    expect(text).toContain('- Verify page-header findings');
    // An unnamed one is still listed, so the count and the list agree.
    expect(text).toContain('- Sub-agent 2');
    expect(text).toContain('Do NOT launch these again');
    expect(text).not.toContain('finished during the interrupted request');
  });

  it('hands over what the finished ones reported, and where to read the rest', () => {
    const text = cursorTransientResumePrompt({
      stillRunning: [],
      finished: [finished()],
    });

    expect(text).toContain(
      'One sub-agent finished during the interrupted request',
    );
    expect(text).toContain('## Verify parent crumb — finished');
    expect(text).toContain('validation: refuted');
    expect(text).toContain(
      'Transcript: /home/.cursor/projects/x/agent-transcripts/a/a.jsonl',
    );
  });

  it('still names a finished sub-agent whose report could not be read', () => {
    // Naming it is what stops the agent assuming it never ran.
    const text = cursorTransientResumePrompt({
      stillRunning: [],
      finished: [
        finished({ outcome: null, finalText: null, recordPath: null }),
      ],
    });

    expect(text).toContain('## Verify parent crumb — ended');
    expect(text).toContain('(It left no final report.)');
  });
});
