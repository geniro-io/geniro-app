import { HOST_PROPOSE_WORKFLOW_TOOL } from '../../../agents/chat.types';

/** Shared body before the blocking vs deferred ending. */
const PROPOSE_PLAN_DESCRIPTION_BODY =
  'Use it when the work is worth more than a couple of edits, when a request could reasonably be read more ' +
  'than one way, or when you are about to touch something wide — a rename across files, a dependency, a ' +
  'schema, anything hard to undo. Do not use it for work you have already been told to do, or for a ' +
  'one-line change: a plan for something obvious is a card in the way. ' +
  'If you have a plan mode of your own (an ExitPlanMode tool, or similar), use EITHER that or this, never ' +
  'both for the same piece of work — two approval cards for one plan is a gate the user has to answer ' +
  'twice. Prefer this one when it is offered: its card is the one rendered in the app they are watching. ' +
  'Call it ONCE, before the work, and do not also write the steps out as text — the user sees the card. ';

const PROPOSE_PLAN_DESCRIPTION_DEFERRED_MIDDLE =
  'The call returns at once — the card is on their screen, so STOP and end your turn. Do not start the work, ' +
  'and do not call this again for the same plan. Their verdict arrives as your next user message: approved ' +
  '(carry it out), or rejected (do NOT do it another way). Either verdict may carry a note from the user — ' +
  'when it does, that note outranks the plan you proposed. ';

const PROPOSE_PLAN_DESCRIPTION_BLOCKING_MIDDLE =
  'The call blocks until they answer, and the result is what to do next: approved (carry it out), or ' +
  'rejected (do NOT do it another way). Either verdict may carry a note from the user — when it does, that ' +
  'note outranks the plan you proposed. ';

const PROPOSE_PLAN_DESCRIPTION_TAIL =
  'Use show_artifact instead when you want to SHOW a plan rather than be approved for one — a laid-out ' +
  'page you keep updating as the work moves. This tool is the gate; that one is the picture, and it asks ' +
  'the user nothing. ' +
  `Use ${HOST_PROPOSE_WORKFLOW_TOOL} instead, where it is offered, when the user wants a saved team of ` +
  'agents (a workflow) rather than a plan for the work in this chat.';

/**
 * What a model reads about `propose_plan`.
 *
 * `answersAtOnce` is true when the CLI will not hold the call open for the
 * user's verdict (`PlanBroker.answersAtOnce`) — see `proposePatchInstructions`.
 */
export function proposePlanInstructions(answersAtOnce: boolean): string {
  const wait = answersAtOnce ? 'wait' : 'WAIT';
  return (
    `Show the user how you intend to carry out a request, and ${wait} for them to approve it before you start. ` +
    PROPOSE_PLAN_DESCRIPTION_BODY +
    (answersAtOnce
      ? PROPOSE_PLAN_DESCRIPTION_DEFERRED_MIDDLE
      : PROPOSE_PLAN_DESCRIPTION_BLOCKING_MIDDLE) +
    PROPOSE_PLAN_DESCRIPTION_TAIL
  );
}
