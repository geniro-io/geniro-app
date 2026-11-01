import { describe, expect, it } from 'vitest';

import {
  ApprovalModeSchema,
  TEAM_AGENT_KINDS,
  TeamAgentNodeSchema,
  TeamAgentPoolMemberSchema,
  TeamEdgeSchema,
  TeamInstructionNodeSchema,
  TeamSchema,
  TeamStageSchema,
  TeamTriggerNodeSchema,
  TRIGGER_KINDS,
} from '../teams.types';
import { teamJsonSchema } from './team-json-schema';

interface JsonObjectSchema {
  properties: Record<string, unknown>;
  required?: string[];
}

const SCHEMA = JSON.parse(teamJsonSchema()) as JsonObjectSchema & {
  $defs: Record<string, JsonObjectSchema & { enum?: string[] }>;
};

describe('teamJsonSchema', () => {
  // The reason the file is generated rather than written: every field the
  // validator knows is in it, including ones added after this spec.
  it.each([
    ['TeamAgentNode', TeamAgentNodeSchema],
    ['TeamTriggerNode', TeamTriggerNodeSchema],
    ['TeamInstructionNode', TeamInstructionNodeSchema],
    ['TeamAgentPoolMember', TeamAgentPoolMemberSchema],
    ['TeamEdge', TeamEdgeSchema],
    ['TeamStage', TeamStageSchema],
  ])('describes every field of %s', (id, schema) => {
    expect(Object.keys(SCHEMA.$defs[id]!.properties).sort()).toEqual(
      Object.keys(schema.shape).sort(),
    );
  });

  it('describes every top-level field of a team', () => {
    expect(Object.keys(SCHEMA.properties).sort()).toEqual(
      Object.keys(TeamSchema.shape).sort(),
    );
  });

  it('carries every value of the enums the validator accepts', () => {
    expect(SCHEMA.$defs.AgentKind!.enum).toEqual([...TEAM_AGENT_KINDS]);
    expect(SCHEMA.$defs.ApprovalMode!.enum).toEqual(ApprovalModeSchema.options);
    expect(SCHEMA.$defs.TriggerKind!.enum).toEqual([...TRIGGER_KINDS]);
  });

  // The STRICT schema: an agent following it writes `approval` itself rather
  // than leaning on the YAML reader's default.
  it('requires what the builder always writes', () => {
    expect(SCHEMA.$defs.TeamAgentNode!.required).toEqual(
      expect.arrayContaining(['id', 'kind', 'agent', 'approval']),
    );
  });
});
