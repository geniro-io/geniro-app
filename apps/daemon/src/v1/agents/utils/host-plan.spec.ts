import { describe, expect, it } from 'vitest';

import {
  HOST_PLAN_TOOL,
  MAX_PLAN_STEP_DETAIL_LENGTH,
  MAX_PLAN_STEP_TITLE_LENGTH,
  MAX_PLAN_STEPS,
} from '../chat.types';
import { hostPlanResultText, isHostPlanCall, readHostPlan } from './host-plan';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostPlanCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(isHostPlanCall(SERVER, `mcp__${SERVER}__${HOST_PLAN_TOOL}`)).toBe(
      true,
    );
    expect(isHostPlanCall(SERVER, `${SERVER}: ${HOST_PLAN_TOOL}`)).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostPlanCall(SERVER, 'mcp__acme__propose_plan')).toBe(false);
    expect(isHostPlanCall(null, `mcp__${SERVER}__${HOST_PLAN_TOOL}`)).toBe(
      false,
    );
  });
});

describe('readHostPlan', () => {
  it('reads a plan', () => {
    expect(
      readHostPlan({
        title: 'Fix the flaky queue test',
        steps: [
          { title: 'Reproduce it', detail: 'Run the suite 20× with --seed' },
          { title: 'Replace the sleep with a wait-for' },
        ],
      }),
    ).toEqual({
      ok: true,
      plan: {
        title: 'Fix the flaky queue test',
        steps: [
          { title: 'Reproduce it', detail: 'Run the suite 20× with --seed' },
          { title: 'Replace the sleep with a wait-for' },
        ],
      },
    });
  });

  it('refuses a plan with no title, and says which field', () => {
    // The refusals carry a sentence rather than a bare null precisely so the
    // agent can fix the call — asserting the FIELD NAME is what pins that.
    const read = readHostPlan({ steps: [{ title: 'a' }] });
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain("'title'");
  });

  it('refuses a plan whose steps hold nothing readable', () => {
    // A card with no rows is not a plan anybody can answer, so this is a
    // malformed call rather than an empty plan — the same split the findings
    // tool draws, decided the other way because an empty findings report is a
    // real review outcome and an empty plan never is.
    for (const steps of [[], [{}], ['step one'], [{ title: '   ' }]]) {
      const read = readHostPlan({ title: 'Something', steps });
      expect(read.ok).toBe(false);
      expect(read.ok === false && read.reason).toContain("'steps'");
    }
    const noArray = readHostPlan({ title: 'Something', steps: 'one, two' });
    expect(noArray.ok).toBe(false);
  });

  it('DROPS an unreadable step and keeps the rest', () => {
    // Nothing here is positional — unlike a chart's values, where a dropped
    // point would shift every later one — so a bad row leaves no hole.
    const read = readHostPlan({
      title: 'Plan',
      steps: [
        { title: 'first' },
        null,
        42,
        { detail: 'no title' },
        { title: 'last' },
      ],
    });
    expect(read.ok === true && read.plan.steps).toEqual([
      { title: 'first' },
      { title: 'last' },
    ]);
  });

  it('TRUNCATES rather than refusing, unlike the patch tool', () => {
    const read = readHostPlan({
      title: 'Plan',
      steps: Array.from({ length: MAX_PLAN_STEPS + 4 }, () => ({
        title: 'x'.repeat(MAX_PLAN_STEP_TITLE_LENGTH + 10),
        detail: 'y'.repeat(MAX_PLAN_STEP_DETAIL_LENGTH + 10),
      })),
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.plan.steps).toHaveLength(MAX_PLAN_STEPS);
      expect(read.plan.steps[0]?.title).toHaveLength(
        MAX_PLAN_STEP_TITLE_LENGTH,
      );
      expect(read.plan.steps[0]?.detail).toHaveLength(
        MAX_PLAN_STEP_DETAIL_LENGTH,
      );
    }
  });

  it('leaves an absent detail absent rather than blank', () => {
    const read = readHostPlan({
      title: 'Plan',
      steps: [{ title: 'a', detail: '   ' }],
    });
    expect(read.ok === true && read.plan.steps[0]).toEqual({ title: 'a' });
  });
});

describe('hostPlanResultText', () => {
  it('tells an approved agent to carry the plan out', () => {
    expect(hostPlanResultText({ status: 'approved' })).toContain('approved');
    expect(hostPlanResultText({ status: 'approved' })).toContain(
      'Carry it out',
    );
  });

  it('carries a note INTO the sentence, on both verdicts', () => {
    // The note is the reason this tool beats a bare yes/no, so it must reach
    // the agent's words rather than being recorded and dropped.
    const yes = hostPlanResultText({
      status: 'approved',
      note: 'skip step 3',
    });
    expect(yes).toContain('skip step 3');
    const no = hostPlanResultText({
      status: 'declined',
      note: 'leave the parser alone',
    });
    expect(no).toContain('leave the parser alone');
    // …and a refusal that came with a redirection must not tell the agent to
    // go and ask what the user would prefer: they just said.
    expect(no).not.toContain('ask what they would prefer');
    expect(hostPlanResultText({ status: 'declined' })).toContain(
      'ask what they would prefer',
    );
  });

  it('tells an unreachable channel to fall back to words', () => {
    expect(
      hostPlanResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toContain('no turn');
  });
});
