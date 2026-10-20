import {
  HOST_PLAN_TOOL,
  HOST_READ_WORKFLOWS_TOOL,
} from '../../../agents/chat.types';
import { workflowConnectionLines } from '../../../graphs/utils/workflow-chat-instructions';

/** What a model reads about `propose_workflow`. */
export function proposeWorkflowInstructions(): string {
  return [
    "Propose a whole geniro workflow — a saved team of CLI agents wired into a graph — on a card the user approves. The daemon checks it the way a run start would and, only on the user's Approve, writes it to their workflow library (backing up a file it replaces). You never write the file yourself.",
    `Use it when the user asks you to build, set up or change a workflow or a team of agents. Read the library first with ${HOST_READ_WORKFLOWS_TOOL}; to change an existing workflow, send it whole with \`replaces\` set to its slug.`,
    `Do not use it to lay out a plan of work for this chat — use ${HOST_PLAN_TOOL} instead. It never runs a workflow.`,
    "Every agent node must state `approval`: 'auto' lets that agent run tools without asking — choose it only where the user wants that; the card lists every such agent for the user. A workflow needs a trigger node wired to its first agent. Allowed connections:",
    ...workflowConnectionLines(),
    'A proposal that could not run is refused with the reason, and no card is shown. Otherwise the card stands until the user answers, with no time limit: END YOUR TURN after calling this. The verdict — approved and saved, declined with their note, or not saved and why — arrives as your next message. A second proposal replaces the card still standing.',
  ].join('\n');
}
