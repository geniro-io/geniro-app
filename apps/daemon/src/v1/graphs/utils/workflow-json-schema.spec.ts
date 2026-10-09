import { describe, expect, it } from 'vitest';

import {
  ApprovalModeSchema,
  TRIGGER_KINDS,
  WORKFLOW_AGENT_KINDS,
  WorkflowAgentNodeSchema,
  WorkflowAgentPoolMemberSchema,
  WorkflowEdgeSchema,
  WorkflowInstructionNodeSchema,
  WorkflowTriggerNodeSchema,
} from '../graphs.types';
import { workflowJsonSchema } from './workflow-json-schema';

interface JsonObjectSchema {
  properties: Record<string, unknown>;
  required?: string[];
}

const SCHEMA = JSON.parse(workflowJsonSchema()) as {
  $defs: Record<string, JsonObjectSchema & { enum?: string[] }>;
};

describe('workflowJsonSchema', () => {
  // The reason the file is generated rather than written: every field the
  // validator knows is in it, including ones added after this spec.
  it.each([
    ['WorkflowAgentNode', WorkflowAgentNodeSchema],
    ['WorkflowTriggerNode', WorkflowTriggerNodeSchema],
    ['WorkflowInstructionNode', WorkflowInstructionNodeSchema],
    ['WorkflowAgentPoolMember', WorkflowAgentPoolMemberSchema],
    ['WorkflowEdge', WorkflowEdgeSchema],
  ])('describes every field of %s', (id, schema) => {
    expect(Object.keys(SCHEMA.$defs[id]!.properties).sort()).toEqual(
      Object.keys(schema.shape).sort(),
    );
  });

  it('carries every value of the enums the validator accepts', () => {
    expect(SCHEMA.$defs.AgentKind!.enum).toEqual([...WORKFLOW_AGENT_KINDS]);
    expect(SCHEMA.$defs.ApprovalMode!.enum).toEqual(ApprovalModeSchema.options);
    expect(SCHEMA.$defs.TriggerKind!.enum).toEqual([...TRIGGER_KINDS]);
  });

  // The STRICT schema: an agent following it writes `approval` itself rather
  // than leaning on the YAML reader's default.
  it('requires what the builder always writes', () => {
    expect(SCHEMA.$defs.WorkflowAgentNode!.required).toEqual(
      expect.arrayContaining(['id', 'kind', 'agent', 'approval']),
    );
  });
});
