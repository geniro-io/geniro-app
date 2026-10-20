import { describe, expect, it } from 'vitest';

import {
  proposeWorkflowResultText,
  readProposeWorkflowArgs,
} from './propose-workflow.reader';

const WORKFLOW = { name: 'Team', nodes: [], edges: [] };

describe('readProposeWorkflowArgs', () => {
  it('reads a workflow with an optional target and summary', () => {
    expect(
      readProposeWorkflowArgs({
        workflow: WORKFLOW,
        replaces: 'team',
        summary: 'adds a reviewer',
      }),
    ).toEqual({
      ok: true,
      query: {
        workflow: WORKFLOW,
        replaces: 'team',
        summary: 'adds a reviewer',
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
