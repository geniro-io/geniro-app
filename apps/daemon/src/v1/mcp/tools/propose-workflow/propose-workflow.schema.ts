import { z } from 'zod';

import { HOST_READ_WORKFLOWS_TOOL } from '../../../agents/chat.types';
import {
  WORKFLOW_SUMMARY_MAX,
  WorkflowSchema,
} from '../../../graphs/graphs.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../graphs/utils/config-dir-redaction';

/**
 * `propose_workflow`'s arguments. `workflow` is GENERATED from `WorkflowSchema`,
 * the schema the proposal is checked against, so the shape a model is shown
 * cannot drift from the one it is held to.
 */
export function proposeWorkflowSchema(): Record<string, unknown> {
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
    },
    required: ['workflow'],
    additionalProperties: false,
  };
}
