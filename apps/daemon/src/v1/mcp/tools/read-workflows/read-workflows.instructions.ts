import {
  HOST_PROPOSE_WORKFLOW_TOOL,
  HOST_WORKFLOW_CHANGE_TOOL,
} from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../graphs/utils/config-dir-redaction';

const WHAT_IT_ANSWERS =
  "Read the user's geniro workflow library — the saved teams of agents they run from the Workflows " +
  'screen. With no argument it lists every workflow (slug, name, description, node and edge counts, ' +
  "agents by CLI); with `slug` it answers that one workflow in full, as JSON — an agent's config " +
  `directory reads as a token, "${CONFIG_DIR_TOKEN_PREFIX}…>": `;

/**
 * What a model reads about `read_workflows` — in an ordinary chat, or in the
 * builder chat docked under one workflow's canvas.
 */
export function readWorkflowsInstructions(forBuilder: boolean): string {
  if (forBuilder) {
    return (
      WHAT_IT_ANSWERS +
      `edits to ${HOST_PROPOSE_WORKFLOW_TOOL} or ${HOST_WORKFLOW_CHANGE_TOOL} that write the token back ` +
      'unchanged keep that profile. ' +
      "Use it when you want the user's other workflows as examples, by name; read the workflow this " +
      `chat edits from its file, which ${HOST_PROPOSE_WORKFLOW_TOOL} changes. ` +
      'It reads only; nothing here changes a workflow.'
    );
  }
  return (
    WHAT_IT_ANSWERS +
    'a replacement of that workflow that keeps the token on an agent of the same CLI keeps that ' +
    'profile, wherever the agent moves; a new workflow cannot carry one. ' +
    `Use it when the user talks about their workflows, and before ${HOST_PROPOSE_WORKFLOW_TOOL}: to ` +
    'see what already exists, to avoid proposing a duplicate, and to start a change from the workflow ' +
    'as it stands rather than from memory. ' +
    'It reads only; nothing here changes a workflow.'
  );
}
