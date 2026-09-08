import { describe, expect, it } from 'vitest';

import {
  inheritsProjectRunConfig,
  targetLabel,
  targetOf,
  targetPatch,
} from './task-target';

describe('targetOf', () => {
  it('reads an agent row as its CLI kind', () => {
    expect(targetOf({ agentKind: 'claude', workflowSlug: null })).toBe(
      'claude',
    );
  });

  it('reads a workflow row as the composer’s own `wf:` encoding', () => {
    expect(targetOf({ agentKind: null, workflowSlug: 'dev-team' })).toBe(
      'wf:dev-team',
    );
  });

  it('lets a workflow win, matching the daemon’s own resolution order', () => {
    // Both columns set is reachable — a project pinning an agent and later a
    // workflow — and `resolveRunTarget` answers the workflow. Disagreeing here
    // would draw a picker on `claude` over a board that runs the graph.
    expect(targetOf({ agentKind: 'claude', workflowSlug: 'dev-team' })).toBe(
      'wf:dev-team',
    );
  });

  it('answers null when the row names nothing', () => {
    expect(targetOf({ agentKind: null, workflowSlug: null })).toBeNull();
    expect(targetOf({})).toBeNull();
  });
});

describe('targetPatch', () => {
  it('CLEARS the workflow when an agent is chosen', () => {
    // The whole reason both fields are always written: without the explicit
    // null a card moved from a workflow to an agent keeps its slug, and the
    // daemon — which reads a workflow first — goes on running the graph while
    // the picker shows the agent.
    expect(targetPatch('claude')).toEqual({
      agentKind: 'claude',
      workflowSlug: null,
    });
  });

  it('CLEARS the agent when a workflow is chosen', () => {
    expect(targetPatch('wf:dev-team')).toEqual({
      agentKind: null,
      workflowSlug: 'dev-team',
    });
  });

  it('clears both for the reset, which is what hands a card back to its project', () => {
    expect(targetPatch(null)).toEqual({ agentKind: null, workflowSlug: null });
  });

  it('round-trips a slug carrying a colon of its own', () => {
    // `wf:` is a PREFIX, not a separator: the pattern is greedy past the first
    // colon, so a slug with one survives.
    expect(targetPatch('wf:team:v2').workflowSlug).toBe('team:v2');
  });
});

describe('targetLabel', () => {
  const library = [{ slug: 'dev-team', name: 'Dev team' }];

  it('names a workflow by its NAME, not the slug the wire carries', () => {
    expect(targetLabel('wf:dev-team', library)).toBe('Dev team');
  });

  it('falls back to the slug for a workflow the library no longer holds', () => {
    // A deleted workflow still says something rather than rendering blank.
    expect(targetLabel('wf:gone', library)).toBe('gone');
  });

  it('leaves an agent as it is', () => {
    expect(targetLabel('cursor-agent', library)).toBe('cursor-agent');
  });

  it('answers null for a row naming nothing', () => {
    expect(targetLabel(null, library)).toBeNull();
  });
});

/**
 * Which of the project's run settings reach a card.
 *
 * The daemon decides this for real (`resolveRunTarget`); the panel restates it
 * so it can show what a card would actually run with, and the two must agree —
 * a `PROJECT` tag beside a value that will never be sent is worse than no tag.
 */
describe('inheritsProjectRunConfig', () => {
  it('inherits everything when the card names no agent of its own', () => {
    expect(inheritsProjectRunConfig(null, 'claude')).toBe(true);
  });

  it('inherits when both name the SAME agent', () => {
    // The project's model is a model for that CLI, so it still applies.
    expect(inheritsProjectRunConfig('claude', 'claude')).toBe(true);
  });

  it('inherits NOTHING when the card names a different agent', () => {
    // The defect this exists to prevent, from the daemon's own doc: handing a
    // claude model to a cursor run. A card that overrides the agent overrides
    // everything that belongs to it.
    expect(inheritsProjectRunConfig('cursor-agent', 'claude')).toBe(false);
    expect(inheritsProjectRunConfig('wf:review', 'claude')).toBe(false);
  });

  it('inherits nothing from a project that names nothing', () => {
    // Not a special case in the predicate — `null === null` is the same
    // "same target" arm — but worth pinning, since the caller then has no
    // values to show and must draw no tag.
    expect(inheritsProjectRunConfig('claude', null)).toBe(false);
  });
});
