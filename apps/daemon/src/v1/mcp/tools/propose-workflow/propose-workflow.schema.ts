import { z } from 'zod';

import { HOST_READ_WORKFLOWS_TOOL } from '../../../agents/chat.types';
import {
  WORKFLOW_REASON_MAX,
  WORKFLOW_SUMMARY_MAX,
  WorkflowSchema,
} from '../../../graphs/graphs.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../graphs/utils/config-dir-redaction';
import { toolInputSchema } from '../tool-args';
import { ProposeWorkflowChangeArgsSchema } from './propose-workflow.reader';

const REASON_DESCRIPTION = `Why, for the card, at most ${WORKFLOW_REASON_MAX} characters: what the user asked for or what you found that this answers.`;

/**
 * `propose_workflow`'s arguments. `workflow` is GENERATED from `WorkflowSchema`,
 * the schema the proposal is checked against, so the shape a model is shown
 * cannot drift from the one it is held to. A builder chat's are generated from
 * the schema they are parsed with: edits, what they change and why.
 */
export function proposeWorkflowSchema(
  forBuilder: boolean,
): Record<string, unknown> {
  if (forBuilder) {
    const schema = toolInputSchema(ProposeWorkflowChangeArgsSchema);
    const properties = schema.properties as Record<string, unknown>;
    return {
      ...schema,
      properties: {
        ...properties,
        summary: {
          ...(properties.summary as Record<string, unknown>),
          description: `One line for the card, at most ${WORKFLOW_SUMMARY_MAX} characters: what this change does to the workflow.`,
        },
        reason: {
          ...(properties.reason as Record<string, unknown>),
          description: REASON_DESCRIPTION,
        },
      },
    };
  }
  const { $schema: _dialect, ...workflow } = z.toJSONSchema(WorkflowSchema, {
    io: 'input',
  });
  return {
    type: 'object',
    properties: {
      workflow: {
        ...workflow,
        description: `The whole workflow, as the library file would hold it. Every agent node states its own \`approval\`. A \`configDir\` read from ${HOST_READ_WORKFLOWS_TOOL} as "${CONFIG_DIR_TOKEN_PREFIX}…>" is sent back as that token (only when replacing that workflow); never guess a path.`,
      },
      replaces: {
        type: 'string',
        description: `The slug of the library workflow this proposal replaces, as ${HOST_READ_WORKFLOWS_TOOL} names it. Leave it out for a new workflow.`,
      },
      summary: {
        type: 'string',
        description: `One line for the card, at most ${WORKFLOW_SUMMARY_MAX} characters: what this workflow does, or what the replacement changes.`,
      },
      reason: { type: 'string', description: REASON_DESCRIPTION },
    },
    required: ['workflow'],
    additionalProperties: false,
  };
}
