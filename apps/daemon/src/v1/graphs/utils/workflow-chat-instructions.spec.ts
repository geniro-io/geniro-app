import { describe, expect, it } from 'vitest';

import {
  EDGE_KINDS,
  NODE_KINDS,
  TRIGGER_KINDS,
  WORKFLOW_AGENT_KINDS,
} from '../graphs.types';
import { composeWorkflowChatInstructions } from './workflow-chat-instructions';

const BRIEF = composeWorkflowChatInstructions({
  path: '/Users/x/Library/Application Support/Geniro/workflows/dev-team.geniro.yaml',
  name: 'Dev Team',
});

describe('composeWorkflowChatInstructions', () => {
  it('names the one file this chat edits, in full', () => {
    expect(BRIEF).toContain(
      '/Users/x/Library/Application Support/Geniro/workflows/dev-team.geniro.yaml',
    );
  });

  it('names the workflow the way the user sees it in the builder', () => {
    expect(BRIEF).toContain('"Dev Team"');
  });

  it('tells the agent to edit the file rather than describe the edit', () => {
    expect(BRIEF).toMatch(/EDITING THE FILE/);
  });

  // These four are the whole reason the brief reads its vocabularies off the
  // schemas' own constants: a kind added to the format has to reach the
  // description of the format, and a hand-typed list is what silently stops
  // doing that. Each loop fails the moment a member is added and the brief is
  // not regenerated from the constant.
  it('lists every node kind the schema accepts', () => {
    for (const kind of NODE_KINDS) {
      expect(BRIEF).toContain(kind);
    }
  });

  it('lists every edge kind the schema accepts', () => {
    for (const kind of EDGE_KINDS) {
      expect(BRIEF).toContain(kind);
    }
  });

  it('lists every trigger kind the schema accepts', () => {
    for (const kind of TRIGGER_KINDS) {
      expect(BRIEF).toContain(kind);
    }
  });

  it('lists every agent kind a node may run', () => {
    for (const kind of WORKFLOW_AGENT_KINDS) {
      expect(BRIEF).toContain(kind);
    }
  });
});
