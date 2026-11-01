import { describe, expect, it } from 'vitest';

import { member } from '../__tests__/team-builders';
import type { TeamMember } from '../teams.types';
import {
  ANSWERING_A_CALL,
  ANSWERING_WITH_CALLS_OUT,
  calleeSummary,
  flattenText,
} from './callee-text';

function agent(patch: Partial<TeamMember> = {}): TeamMember {
  return member('reviewer', patch);
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

describe('calleeSummary — agent pool', () => {
  it('numbers a pooled callee’s members the way call_agent takes them', () => {
    expect(
      calleeSummary(
        agent({
          name: 'Reviewer',
          role: 'Reviews a diff.',
          model: 'opus',
          configDir: '/profiles/work',
          pool: [{ agent: 'codex', model: 'gpt-5.5' }],
        }),
        200,
      ),
    ).toBe(
      'Reviewer (agent id: reviewer) — Reviews a diff. [agent pool — 1: claude · opus · separate profile; 2: codex · gpt-5.5]',
    );
  });

  it('says nothing about a pool for a callee with none', () => {
    expect(calleeSummary(agent({ name: 'Reviewer' }), 200)).not.toContain(
      'pool',
    );
  });
});

describe('calleeSummary', () => {
  it('carries the callee role', () => {
    expect(
      calleeSummary(agent({ name: 'Reviewer', role: 'Reviews a diff.' }), 200),
    ).toBe('Reviewer (agent id: reviewer) — Reviews a diff.');
  });

  it('NEVER leaks the callee instructions or character — that is private text', () => {
    // The isolation guarantee: a caller learns what a callee is FOR (its
    // public role), never how it works. If private text ever reaches a caller,
    // this fails.
    const summary = calleeSummary(
      agent({
        name: 'Reviewer',
        role: 'Reviews a diff.',
        instructions: 'Run the geniro:review skill and write a handoff file.',
        character: 'Blunt and terse.',
      }),
      200,
    );
    expect(summary).toContain('Reviews a diff.');
    expect(summary).not.toContain('geniro:review');
    expect(summary).not.toContain('handoff');
    expect(summary).not.toContain('Blunt');
  });

  it('falls back to the bare label when a callee has no role', () => {
    // A role-less callee is still addressable — the caller just gets no
    // routing signal for it (which the builder warns about).
    expect(calleeSummary(agent({ name: 'Reviewer' }), 200)).toBe(
      'Reviewer (agent id: reviewer)',
    );
    expect(
      calleeSummary(
        agent({ name: 'Reviewer', instructions: 'Secret instructions.' }),
        200,
      ),
    ).not.toContain('Secret instructions.');
  });

  it('drops the redundant id when the name IS the id', () => {
    expect(calleeSummary(agent({ role: 'Reviews a diff.' }), 200)).toBe(
      'reviewer — Reviews a diff.',
    );
    expect(calleeSummary(agent(), 200)).toBe('reviewer');
  });

  it('flattens and caps a long multi-line role', () => {
    const summary = calleeSummary(
      agent({ name: 'Reviewer', role: 'Reviews\ncode\nand diffs.' }),
      10,
    );
    expect(summary).toBe('Reviewer (agent id: reviewer) — Reviews co…');
  });
});

describe('what a callee is told about its answer', () => {
  it('tells every callee its answer is its final turn’s reply, naming no tool', () => {
    // Said to a callee that may call nobody, so it must not lean on the call
    // tools that one is never handed.
    expect(ANSWERING_A_CALL).toContain(
      'Your answer to it is the reply you end your final turn in this call with',
    );
    expect(ANSWERING_A_CALL).not.toMatch(/call_agent|await_agent/);
  });

  it('tells a callee that can call that its own calls keep the answer owed', () => {
    expect(ANSWERING_WITH_CALLS_OUT).toContain(
      'does NOT hand back your result',
    );
  });
});
