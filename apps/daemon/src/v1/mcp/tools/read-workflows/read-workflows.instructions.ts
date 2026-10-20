import { HOST_PROPOSE_WORKFLOW_TOOL } from '../../../agents/chat.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../graphs/utils/config-dir-redaction';

/** What a model reads about `read_workflows`. */
export function readWorkflowsInstructions(): string {
  return (
    "Read the user's geniro workflow library — the saved teams of agents they run from the Workflows " +
    'screen. With no argument it lists every workflow (slug, name, description, node and edge counts, ' +
    "agents by CLI); with `slug` it answers that one workflow in full, as JSON — an agent's config " +
    `directory reads as a token, "${CONFIG_DIR_TOKEN_PREFIX}…>": a replacement of that workflow that ` +
    'keeps the token on an agent of the same CLI keeps that profile, wherever the agent moves; a new ' +
    'workflow cannot carry one. ' +
    `Use it when the user talks about their workflows, and before ${HOST_PROPOSE_WORKFLOW_TOOL}: to ` +
    'see what already exists, to avoid proposing a duplicate, and to start a change from the workflow ' +
    'as it stands rather than from memory. ' +
    'It reads only; nothing here changes a workflow.'
  );
}
