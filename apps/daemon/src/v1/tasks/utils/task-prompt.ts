import type { Task } from '../entity/task.entity';
import type { TaskFileWire } from '../tasks.types';

/** The closing sentence both engines are asked for, in the same words. */
const REPORT_OPENING =
  'You are working a single task from a board. When you are finished, close with a report of what you did.';
const REPORT_PROSE =
  'Write the report as your final message: what changed, what you verified, and anything you deliberately left undone.';

/**
 * What geniro asks a task's agent to do, on top of whatever the user's own
 * standing instructions already say.
 *
 * It rides the run's `customInstructions` snapshot rather than the prompt,
 * because the prompt is what a CLI NAMES the conversation from: leading with
 * house-keeping had cursor-agent titling chats after geniro's own preamble
 * (see `AgentAdapter.composeSystemPrompt`), and the same would happen here.
 *
 * `report_findings` is named rather than described because it is registered
 * for every chat this daemon runs, on either CLI — so the agent can be asked
 * for a structured report with no per-CLI branch. Prose is the fallback and is
 * stated as one, since an agent that cannot call the tool must still finish by
 * saying what it did rather than treating the instruction as unmeetable.
 */
export const TASK_REPORT_INSTRUCTIONS = [
  REPORT_OPENING,
  'Prefer the `report_findings` tool — it draws a structured report the user can read at a glance.',
  `If you cannot call it, ${REPORT_PROSE.charAt(0).toLowerCase()}${REPORT_PROSE.slice(1)}`,
].join('\n');

/**
 * The same ask, for a task run through a WORKFLOW — and the difference is one
 * sentence that had to go.
 *
 * A graph node cannot see `report_findings`: the render family is gated on
 * `HostSinkBroker`, nothing registers a sink outside `ChatService`, and a node
 * with no outgoing call edges is handed no MCP endpoint at all. Naming the tool
 * anyway is worse than saying nothing — it asks every node of the graph for a
 * call it will look for, fail to find, and have to reason its way around, and
 * the fallback then reads as a consolation rather than as the instruction.
 *
 * The prose sentence is therefore stated FLATLY here, in the same words the
 * chat variant uses for its fallback, so the two cannot drift into asking for
 * different reports. `TaskSettleService.findReport` reads the last message of a
 * terminal node for exactly this.
 */
export const TASK_REPORT_INSTRUCTIONS_WORKFLOW = [
  REPORT_OPENING,
  REPORT_PROSE,
].join('\n');

/**
 * The task's own brief, as the agent's opening message.
 *
 * The title alone when there is no description — an empty section under a
 * heading reads as a section the author forgot to fill in, which is a worse
 * brief than the one line that is actually known.
 */
export function composeTaskPrompt(
  task: Pick<Task, 'title' | 'description'>,
  attachments: readonly TaskFileWire[] = [],
  /**
   * What the user added to this one press of Run, if anything.
   *
   * After the description and before the attachment list: it is more of the
   * brief — the newest part of it — where the files are a trailing reference
   * block that stays last for the reason below.
   */
  extra = '',
): string {
  const description = task.description?.trim() ?? '';
  const added = extra.trim();
  const brief = [task.title, description, added]
    .filter((part) => part !== '')
    .join('\n\n');
  if (attachments.length === 0) {
    return brief;
  }
  // LAST, and by PATH. Last because the prompt is what a CLI names the
  // conversation from — a list of file paths at the top would title the chat
  // after somebody's Downloads folder, which is the same trap the doc block
  // above records for the report instructions. By path because that is the
  // whole of what an attachment is here: a file already on this machine that
  // the agent can open with the tools it already has, so there is nothing to
  // teach it and nothing to decode.
  //
  // Without this the feature would be decorative: a user attaches an archive,
  // the panel lists it, and the agent working the card is never told it exists.
  return [
    brief,
    '',
    'Files attached to this task:',
    ...attachments.map((file) => `- ${file.path}`),
  ].join('\n');
}
