import type { OpenAPIObject } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeOpenApiSchemas,
  findDanglingSchemaRefs,
} from './openapi-schemas';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const docWith = (
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
): OpenAPIObject =>
  ({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths,
    components: { schemas },
  }) as unknown as OpenAPIObject;

const schemasOf = (doc: OpenAPIObject): Record<string, unknown> =>
  (doc.components?.schemas ?? {}) as Record<string, unknown>;

describe('canonicalizeOpenApiSchemas', () => {
  it('drops the _Output suffix from component names and from every $ref', () => {
    const doc = docWith(
      {
        Workflow_Output: {
          id: 'Workflow_Output',
          type: 'object',
          properties: { node: ref('WorkflowNode_Output') },
        },
        WorkflowNode_Output: { id: 'WorkflowNode_Output', type: 'object' },
      },
      {
        '/w': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': { schema: ref('Workflow_Output') },
                },
              },
            },
          },
        },
      },
    );

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out)).sort()).toEqual([
      'Workflow',
      'WorkflowNode',
    ]);
    expect(schemasOf(out).Workflow).toEqual({
      type: 'object',
      properties: { node: ref('WorkflowNode') },
    });
    expect(JSON.stringify(out.paths)).toContain(
      '#/components/schemas/Workflow',
    );
    expect(JSON.stringify(out)).not.toContain('_Output');
  });

  it('aliases the request-side <DtoName><Property> expansion onto the zod id, level by level', () => {
    // The exact shape nestjs-zod emits for one domain type used in both
    // directions: the response side keeps the zod ids (suffixed), the request
    // side is exploded under the DTO name and loses both the id and
    // `additionalProperties: false`. Only the LEAVES match at first — the
    // parents differ purely by which leaf they reference — so this pins the
    // fixed-point loop, not a single merge pass.
    const doc = docWith({
      AgentKind_Output: {
        id: 'AgentKind_Output',
        type: 'string',
        enum: ['claude', 'cursor-agent'],
      },
      WorkflowAgentNode_Output: {
        id: 'WorkflowAgentNode_Output',
        type: 'object',
        properties: { agent: ref('AgentKind_Output') },
        additionalProperties: false,
      },
      Workflow_Output: {
        id: 'Workflow_Output',
        type: 'object',
        properties: { node: ref('WorkflowAgentNode_Output') },
        additionalProperties: false,
      },
      SaveWorkflowDtoAgentKind: {
        type: 'string',
        enum: ['claude', 'cursor-agent'],
      },
      SaveWorkflowDtoWorkflowAgentNode: {
        type: 'object',
        properties: { agent: ref('SaveWorkflowDtoAgentKind') },
      },
      SaveWorkflowDtoWorkflow: {
        type: 'object',
        properties: { node: ref('SaveWorkflowDtoWorkflowAgentNode') },
      },
    });

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out)).sort()).toEqual([
      'AgentKind',
      'Workflow',
      'WorkflowAgentNode',
    ]);
    expect(schemasOf(out).WorkflowAgentNode).toEqual({
      type: 'object',
      properties: { agent: ref('AgentKind') },
    });
    expect(schemasOf(out).Workflow).toEqual({
      type: 'object',
      properties: { node: ref('WorkflowAgentNode') },
    });
  });

  it('rewrites request-body refs onto the canonical component', () => {
    const doc = docWith(
      {
        Thing_Output: {
          id: 'Thing_Output',
          type: 'object',
          properties: { a: { type: 'string' } },
        },
        SaveThingDtoThing: {
          type: 'object',
          properties: { a: { type: 'string' } },
        },
      },
      {
        '/t': {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: ref('SaveThingDtoThing') },
              },
            },
          },
        },
      },
    );

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out))).toEqual(['Thing']);
    expect(JSON.stringify(out.paths)).toContain('#/components/schemas/Thing"');
    expect(JSON.stringify(out.paths)).not.toContain('SaveThingDtoThing');
  });

  it('never merges two anonymous DTOs with each other, however alike', () => {
    // Import and export bodies are both `{ path: string }` but name two
    // different operations' inputs; collapsing them would mislabel the client.
    const doc = docWith({
      ImportWorkflowDto: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      ExportWorkflowDto: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    });

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out)).sort()).toEqual([
      'ExportWorkflowDto',
      'ImportWorkflowDto',
    ]);
  });

  it('never merges two id-bearing components with each other', () => {
    // Distinct zod ids are a deliberate statement that these are distinct
    // domain types, even when they happen to share a shape today.
    const doc = docWith({
      RunStatus_Output: { id: 'RunStatus_Output', type: 'string' },
      TerminalStatus_Output: { id: 'TerminalStatus_Output', type: 'string' },
    });

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out)).sort()).toEqual([
      'RunStatus',
      'TerminalStatus',
    ]);
  });

  it('keeps an anonymous component that genuinely differs from the canonical one', () => {
    // The request allows `approval` to be omitted; the response always carries
    // it. Merging these would lie about the API.
    const doc = docWith({
      Workflow_Output: {
        id: 'Workflow_Output',
        type: 'object',
        properties: { approval: { type: 'string' } },
        required: ['approval'],
      },
      SaveWorkflowDtoWorkflow: {
        type: 'object',
        properties: { approval: { type: 'string' } },
      },
    });

    const out = canonicalizeOpenApiSchemas(doc);

    expect(Object.keys(schemasOf(out)).sort()).toEqual([
      'SaveWorkflowDtoWorkflow',
      'Workflow',
    ]);
  });

  it('strips the zod `id` keyword and `additionalProperties: false` without touching an `id` PROPERTY or a record value schema', () => {
    const doc = docWith({
      Run_Output: {
        id: 'Run_Output',
        type: 'object',
        properties: {
          id: { type: 'string' },
          layout: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    });

    const out = canonicalizeOpenApiSchemas(doc);

    expect(schemasOf(out).Run).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        layout: { type: 'object', additionalProperties: { type: 'number' } },
      },
      required: ['id'],
    });
  });

  it('merges the two directions only because those keywords are gone', () => {
    // Without the strip, the response copy carries `id` +
    // `additionalProperties: false` and the two never match.
    const out = canonicalizeOpenApiSchemas(
      docWith({
        Thing_Output: {
          id: 'Thing_Output',
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
        },
        CreateThingDtoThing: {
          type: 'object',
          properties: { a: { type: 'string' } },
        },
      }),
    );

    expect(Object.keys(schemasOf(out))).toEqual(['Thing']);
  });

  it('is idempotent', () => {
    const doc = docWith({
      AgentKind_Output: { id: 'AgentKind_Output', type: 'string' },
      SaveWorkflowDtoAgentKind: { type: 'string' },
    });

    const once = canonicalizeOpenApiSchemas(doc);
    expect(Object.keys(schemasOf(once))).toEqual(['AgentKind']);
    expect(canonicalizeOpenApiSchemas(once)).toEqual(once);
  });

  it('leaves a document without components untouched', () => {
    const doc = { openapi: '3.1.0', paths: {} } as unknown as OpenAPIObject;
    expect(canonicalizeOpenApiSchemas(doc)).toBe(doc);
  });
});

describe('findDanglingSchemaRefs', () => {
  it('reports the array-response ref nestjs-zod leaves pointing at the DTO name', () => {
    const doc = docWith(
      { Item_Output: { type: 'object' } },
      {
        '/items': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'array', items: ref('ItemDto_Output') },
                  },
                },
              },
            },
          },
        },
      },
    );

    expect(findDanglingSchemaRefs(doc)).toEqual(['ItemDto_Output']);
  });

  it('returns nothing when every ref resolves', () => {
    const doc = docWith(
      { Item: { type: 'object' } },
      {
        '/items': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'array', items: ref('Item') },
                  },
                },
              },
            },
          },
        },
      },
    );

    expect(findDanglingSchemaRefs(doc)).toEqual([]);
  });
});
