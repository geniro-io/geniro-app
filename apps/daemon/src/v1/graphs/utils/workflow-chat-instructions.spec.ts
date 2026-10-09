import { describe, expect, it } from 'vitest';

import {
  ApprovalModeSchema,
  EDGE_KINDS,
  NODE_CONNECTION_RULES,
  NODE_KINDS,
} from '../graphs.types';
import { composeWorkflowChatInstructions } from './workflow-chat-instructions';

const LIBRARY = '/Users/x/Library/Application Support/Geniro/workflows';

const BRIEF = composeWorkflowChatInstructions({
  path: `${LIBRARY}/dev-team.geniro.yaml`,
  name: 'Dev Team',
  schemaPath: `${LIBRARY}/.workflow.schema.json`,
});

describe('composeWorkflowChatInstructions', () => {
  it('names the one file this chat edits, in full', () => {
    expect(BRIEF).toContain(`${LIBRARY}/dev-team.geniro.yaml`);
  });

  it('names the workflow the way the user sees it in the builder', () => {
    expect(BRIEF).toContain('"Dev Team"');
  });

  // The structure reference is the whole defence against a field list that
  // drifts from the validator, so the brief must actually hand it over.
  it('points at the generated schema for the structure', () => {
    expect(BRIEF).toContain(`${LIBRARY}/.workflow.schema.json`);
  });

  it('tells the agent to edit the file rather than describe the edit', () => {
    expect(BRIEF).toMatch(/editing the file with your own file tools/);
  });

  it('tells the agent to read the WHOLE file before editing', () => {
    expect(BRIEF).toMatch(
      /Read the whole workflow file before your first edit/,
    );
  });

  // Each meaning is a `Record` over its enum, so a new member fails the build;
  // these pin that the rendered brief carries every one of them.
  it('explains every node kind the schema accepts', () => {
    for (const kind of NODE_KINDS) {
      expect(BRIEF).toMatch(new RegExp(`^- ${kind}: \\S`, 'm'));
    }
  });

  it('explains every edge kind the schema accepts', () => {
    for (const kind of EDGE_KINDS) {
      expect(BRIEF).toMatch(new RegExp(`^- ${kind}: \\S`, 'm'));
    }
  });

  it('explains every approval mode the schema accepts', () => {
    for (const mode of ApprovalModeSchema.options) {
      expect(BRIEF).toMatch(new RegExp(`^- ${mode}: \\S`, 'm'));
    }
  });

  // Read off NODE_CONNECTION_RULES rather than typed out, so a rule added
  // there reaches the brief with no edit to it.
  it('lists exactly the connections NODE_CONNECTION_RULES allows', () => {
    const listed = [...BRIEF.matchAll(/^- (\w+) → (\w+) \(`(\w+)`\)/gm)]
      .map(([, from, to, edge]) => `${from}->${to}:${edge}`)
      .sort();
    const allowed = NODE_KINDS.flatMap((from) =>
      NODE_CONNECTION_RULES[from].outputs
        .filter((out) =>
          NODE_CONNECTION_RULES[out.kind].inputs.some(
            (rule) => rule.edge === out.edge && rule.kind === from,
          ),
        )
        .map((out) => `${from}->${out.kind}:${out.edge}`),
    ).sort();
    expect(listed).toEqual(allowed);
  });

  it('states the arity limits of a single-edge rule', () => {
    // A trigger feeds one agent, and an agent takes one trigger.
    expect(BRIEF).toContain(
      '- trigger → agent (`data`): each trigger node has only one; each agent node takes only one',
    );
  });

  it('holds the text inside the workflow to the instruction-writing rules', () => {
    expect(BRIEF).toMatch(/One home per fact/);
    expect(BRIEF).toMatch(/Keep a sentence only if removing it would change/);
  });
});
