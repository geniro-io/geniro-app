import { describe, expect, it } from 'vitest';

import {
  AUTOPILOT_APPROVAL,
  resolveRunTarget,
  RUN_TARGET_PROBLEM_CODE,
  RUN_TARGET_PROBLEM_REASON,
} from './run-target';

/**
 * The three rungs, in the order the start route passes them: this press, the
 * card, the project.
 */
const press = (over: Parameters<typeof resolveRunTarget>[0][number] = {}) =>
  over;

describe('resolveRunTarget', () => {
  it('takes the project as the default when nothing more specific speaks', () => {
    expect(
      resolveRunTarget([
        press(),
        press(),
        { agentKind: 'claude', model: 'opus' },
      ]),
    ).toEqual({
      kind: 'agent',
      agentKind: 'claude',
      model: 'opus',
      effort: null,
      approval: null,
      configDir: null,
    });
  });

  it('lets a CARD override the project it belongs to', () => {
    const target = resolveRunTarget([
      press(),
      { agentKind: 'cursor-agent' },
      { agentKind: 'claude' },
    ]);

    expect(target).toMatchObject({ kind: 'agent', agentKind: 'cursor-agent' });
  });

  it('lets the PRESS override the card', () => {
    const target = resolveRunTarget([
      { agentKind: 'claude' },
      { agentKind: 'cursor-agent' },
      { agentKind: 'cursor-agent' },
    ]);

    expect(target).toMatchObject({ kind: 'agent', agentKind: 'claude' });
  });

  it('names the PROBLEM when no rung names an agent or a workflow', () => {
    expect(resolveRunTarget([press(), press(), { model: 'opus' }])).toEqual({
      kind: 'problem',
      reason: 'no-target',
    });
  });

  it('reads a workflow as the whole answer, dropping the CLI-only fields', () => {
    const target = resolveRunTarget([
      press(),
      { workflowSlug: 'dev-team' },
      { agentKind: 'claude', model: 'opus', effort: 'xhigh' },
    ]);

    // Not merely "workflow wins": a graph's nodes name their own model and
    // effort in the YAML, so carrying the project's down would be a run-level
    // answer with nothing to apply it to.
    expect(target).toEqual({ kind: 'workflow', workflowSlug: 'dev-team' });
  });

  it('REFUSES a workflow the autopilot would run, naming that problem', () => {
    // The approval forcing below reaches the agent arm only. A workflow carries
    // `approval` per NODE, so there is no single field to force — an unattended
    // run of one parks on the first node that asks, holding its slot and its
    // worktree, and the breaker never trips because parked is not failed.
    expect(
      resolveRunTarget(
        [press(), { workflowSlug: 'dev-team' }, { agentKind: 'claude' }],
        'autopilot',
      ),
    ).toEqual({ kind: 'problem', reason: 'workflow-unattended' });
  });

  it('lets a USER start the same workflow', () => {
    // The refusal is about nobody being there to answer, not about workflows.
    expect(
      resolveRunTarget(
        [press(), { workflowSlug: 'dev-team' }, { agentKind: 'claude' }],
        'user',
      ),
    ).toEqual({ kind: 'workflow', workflowSlug: 'dev-team' });
  });

  it('distinguishes the two refusals by their sentence', () => {
    // One reason for both is what made a card naming a workflow tell its user
    // to "set an agent or workflow" — advice it had already followed.
    expect(RUN_TARGET_PROBLEM_REASON['no-target']).not.toBe(
      RUN_TARGET_PROBLEM_REASON['workflow-unattended'],
    );
    expect(RUN_TARGET_PROBLEM_CODE['no-target']).not.toBe(
      RUN_TARGET_PROBLEM_CODE['workflow-unattended'],
    );
  });

  it('lets a lower rung name the agent while a higher one is silent', () => {
    // The rung that DECIDES is the first that names a target — a press
    // carrying only a model has not named one, so the card still decides.
    const target = resolveRunTarget([
      { model: 'sonnet' },
      { agentKind: 'claude' },
      { agentKind: 'cursor-agent', model: 'kimi-k3' },
    ]);

    expect(target).toMatchObject({ agentKind: 'claude', model: 'sonnet' });
  });

  it('never inherits a setting from a rung naming a DIFFERENT agent', () => {
    // The defect this exists to prevent: per-field `??` chains handed the
    // project's cursor model to a card the user had pointed at claude, and a
    // model is an opaque string all the way to the CLI, so nothing downstream
    // could notice.
    const target = resolveRunTarget([
      press(),
      { agentKind: 'claude' },
      { agentKind: 'cursor-agent', model: 'kimi-k3', effort: 'max' },
    ]);

    expect(target).toEqual({
      kind: 'agent',
      agentKind: 'claude',
      model: null,
      effort: null,
      approval: null,
      configDir: null,
    });
  });

  it('still inherits from a rung that names no agent at all', () => {
    const target = resolveRunTarget([
      press(),
      { agentKind: 'claude' },
      { model: 'opus', configDir: '/tmp/profile' },
    ]);

    expect(target).toMatchObject({
      agentKind: 'claude',
      model: 'opus',
      configDir: '/tmp/profile',
    });
  });

  it('reads a blank string as unset rather than passing it to a CLI', () => {
    const target = resolveRunTarget([
      { model: '  ' },
      press(),
      { agentKind: 'claude', model: 'opus' },
    ]);

    expect(target).toMatchObject({ model: 'opus' });
  });

  it('forces the autopilot approval over a project that pins its own', () => {
    // The guarantee the conductor cannot make for itself: an unattended `ask`
    // turn does not time out, it waits forever, holding a slot and a worktree.
    const target = resolveRunTarget(
      [press(), press(), { agentKind: 'claude', approval: 'ask' }],
      'autopilot',
    );

    expect(target).toMatchObject({ approval: AUTOPILOT_APPROVAL });
  });

  it('forces a mode that CANNOT stop and ask — the literal, not the constant', () => {
    // Spelled out here on purpose, and it is the one assertion in this file
    // that does not read `AUTOPILOT_APPROVAL`: every test above would pass
    // against any value the constant happened to hold, which is how it sat on
    // `acceptEdits` — a mode that auto-accepts EDITS and routes every Bash
    // call to the approval seam, i.e. to a card nobody is in front of.
    // REPORTED with both of a board's unattended runs parked on
    // `Agent asks to run a tool · Bash`. `auto` is the only mode where the
    // daemon itself answers those requests.
    expect(AUTOPILOT_APPROVAL).toBe('auto');
    expect(
      resolveRunTarget(
        [press(), press(), { agentKind: 'claude' }],
        'autopilot',
      ),
    ).toMatchObject({ approval: 'auto' });
  });

  it('forces it over the REQUEST too, not just the stored rows', () => {
    const target = resolveRunTarget(
      [{ approval: 'ask' }, press(), { agentKind: 'claude' }],
      'autopilot',
    );

    expect(target).toMatchObject({ approval: AUTOPILOT_APPROVAL });
  });

  it('leaves a user-pressed run its own approval mode', () => {
    const target = resolveRunTarget(
      [press(), press(), { agentKind: 'claude', approval: 'ask' }],
      'user',
    );

    expect(target).toMatchObject({ approval: 'ask' });
  });
});
