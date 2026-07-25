import { describe, expect, it } from 'vitest';

import type { WorkflowAgentNode } from '../graphs.types';
import { calleeSummary, flattenText } from './callee-text';

function agent(patch: Partial<WorkflowAgentNode> = {}): WorkflowAgentNode {
  return {
    id: 'reviewer',
    kind: 'agent',
    agent: 'claude',
    approval: 'auto',
    ...patch,
  };
}

describe('flattenText', () => {
  it('returns empty for absent/empty text', () => {
    expect(flattenText(undefined, 100)).toBe('');
    expect(flattenText(null, 100)).toBe('');
    expect(flattenText('   ', 100)).toBe('');
  });

  it('collapses interior whitespace and trims', () => {
    expect(flattenText('  You   review\n\tcode.  ', 100)).toBe(
      'You review code.',
    );
  });

  it('truncates with an ellipsis past the cap, leaves shorter text intact', () => {
    expect(flattenText('abcdefghij', 5)).toBe('abcde…');
    expect(flattenText('abcde', 5)).toBe('abcde');
  });
});

describe('calleeSummary', () => {
  it('carries the callee description', () => {
    expect(
      calleeSummary(
        agent({ name: 'Reviewer', description: 'Reviews a diff.' }),
        200,
      ),
    ).toBe('Reviewer (agent id: reviewer) — Reviews a diff.');
  });

  it('NEVER leaks the callee role — that is private instruction text', () => {
    // The isolation guarantee: a caller learns what a callee is FOR
    // (description), never how it works (role). If role text ever reaches a
    // caller again, this fails.
    const summary = calleeSummary(
      agent({
        name: 'Reviewer',
        description: 'Reviews a diff.',
        role: 'Run the geniro:review skill and write a handoff file.',
      }),
      200,
    );
    expect(summary).toContain('Reviews a diff.');
    expect(summary).not.toContain('geniro:review');
    expect(summary).not.toContain('handoff');
  });

  it('falls back to the bare label when a callee has no description', () => {
    // A describe-less callee is still addressable — the caller just gets no
    // routing signal for it (which the builder warns about).
    expect(calleeSummary(agent({ name: 'Reviewer' }), 200)).toBe(
      'Reviewer (agent id: reviewer)',
    );
    expect(
      calleeSummary(agent({ name: 'Reviewer', role: 'Secret role.' }), 200),
    ).not.toContain('Secret role.');
  });

  it('drops the redundant id when the name IS the id', () => {
    expect(calleeSummary(agent({ description: 'Reviews a diff.' }), 200)).toBe(
      'reviewer — Reviews a diff.',
    );
    expect(calleeSummary(agent(), 200)).toBe('reviewer');
  });

  it('flattens and caps a long multi-line description', () => {
    const summary = calleeSummary(
      agent({ name: 'Reviewer', description: 'Reviews\ncode\nand diffs.' }),
      10,
    );
    expect(summary).toBe('Reviewer (agent id: reviewer) — Reviews co…');
  });
});
