import { describe, expect, it } from 'vitest';

import {
  proposeWorkflowResultText,
  readProposeWorkflowArgs,
  readProposeWorkflowChangeArgs,
} from './propose-workflow.reader';

const WORKFLOW = { name: 'Team', nodes: [], edges: [] };

describe('readProposeWorkflowArgs', () => {
  it('reads a workflow with an optional target, summary and reason', () => {
    expect(
      readProposeWorkflowArgs({
        workflow: WORKFLOW,
        replaces: 'team',
        summary: 'adds a reviewer',
        reason: 'nothing checks the coder',
      }),
    ).toEqual({
      ok: true,
      query: {
        workflow: WORKFLOW,
        replaces: 'team',
        summary: 'adds a reviewer',
        reason: 'nothing checks the coder',
      },
    });
    // A model's null for an unset optional reads as absent.
    expect(
      readProposeWorkflowArgs({ workflow: WORKFLOW, replaces: null }),
    ).toEqual({ ok: true, query: { workflow: WORKFLOW } });
  });

  it('refuses a summary of more than one capped line', () => {
    for (const broken of ['one\ntwo', 'one\u2028two', 'one\u202Etwo']) {
      expect(
        readProposeWorkflowArgs({ workflow: WORKFLOW, summary: broken }).ok,
      ).toBe(false);
    }
    expect(
      readProposeWorkflowArgs({ workflow: WORKFLOW, summary: 'x'.repeat(201) })
        .ok,
    ).toBe(false);
    expect(
      readProposeWorkflowArgs({ workflow: WORKFLOW, summary: 'x'.repeat(200) })
        .ok,
    ).toBe(true);
    // Emoji are visible text, joined sequences included.
    expect(
      readProposeWorkflowArgs({
        workflow: WORKFLOW,
        summary: 'a reviewer ❤️ 👨‍💻',
      }).ok,
    ).toBe(true);
  });

  it('refuses a misspelt target rather than proposing a second workflow', () => {
    expect(
      readProposeWorkflowArgs({ workflow: WORKFLOW, replace: 'team' }).ok,
    ).toBe(false);
    expect(readProposeWorkflowArgs({ workflow: 'name: Team' }).ok).toBe(false);
    expect(readProposeWorkflowArgs({}).ok).toBe(false);
  });
});

describe('readProposeWorkflowChangeArgs', () => {
  const EDITS = [{ path: 'nodes/reviewer/model', value: 'sonnet' }];

  it("reads a builder chat's edits with what they change and why", () => {
    expect(
      readProposeWorkflowChangeArgs({
        edits: EDITS,
        summary: 'Reviewer on sonnet',
        reason:
          'The user asked for a cheaper reviewer.\nIt reviews small diffs.',
      }),
    ).toEqual({
      ok: true,
      query: {
        edits: EDITS,
        summary: 'Reviewer on sonnet',
        reason:
          'The user asked for a cheaper reviewer.\nIt reviews small diffs.',
      },
    });
  });

  it('requires both the summary and the reason the card shows', () => {
    expect(
      readProposeWorkflowChangeArgs({ edits: EDITS, summary: 'x' }).ok,
    ).toBe(false);
    expect(
      readProposeWorkflowChangeArgs({ edits: EDITS, reason: 'x' }).ok,
    ).toBe(false);
  });

  it("refuses a whole workflow or a target: the slug is the chat's", () => {
    const base = { edits: EDITS, summary: 's', reason: 'r' };
    expect(
      readProposeWorkflowChangeArgs({ ...base, workflow: WORKFLOW }).ok,
    ).toBe(false);
    expect(
      readProposeWorkflowChangeArgs({ ...base, replaces: 'other' }).ok,
    ).toBe(false);
    expect(readProposeWorkflowChangeArgs({ ...base, edits: [] }).ok).toBe(
      false,
    );
  });

  it('refuses a reason past its cap or carrying hidden text', () => {
    const base = { edits: EDITS, summary: 's' };
    expect(
      readProposeWorkflowChangeArgs({ ...base, reason: 'x'.repeat(1001) }).ok,
    ).toBe(false);
    expect(
      readProposeWorkflowChangeArgs({ ...base, reason: 'x'.repeat(1000) }).ok,
    ).toBe(true);
    expect(
      readProposeWorkflowChangeArgs({ ...base, reason: 'one\u202Etwo' }).ok,
    ).toBe(false);
  });
});

describe('proposeWorkflowResultText', () => {
  it('tells the agent the card is up and to end its turn', () => {
    expect(
      proposeWorkflowResultText({
        status: 'shown',
        proposal: {
          mode: 'create',
          slug: 'team',
          workflow: WORKFLOW,
          autoAgents: [],
        },
      }),
    ).toBe(
      "Shown to the user on a card: a new workflow, to be saved as 'team'. Nothing is saved until they approve. End your turn now — their verdict arrives as your next message.",
    );
  });

  it('names the check that refused a proposal, and that no card was shown', () => {
    expect(
      proposeWorkflowResultText({
        status: 'refused',
        code: 'GRAPH_NO_TRIGGER',
        message: 'add a trigger',
      }),
    ).toBe(
      'Not proposed — GRAPH_NO_TRIGGER: add a trigger. No card was shown.',
    );
  });
});
