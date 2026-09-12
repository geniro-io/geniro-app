import type { Task } from '../entity/task.entity';
import type { TaskFileWire } from '../tasks.types';

/** The closing sentence both engines are asked for, in the same words. */
const REPORT_OPENING =
  'You are working a single task from a board. When you are finished, close with a report of what you did.';
/**
 * The ask both engines also need, and the one the first sentence does not
 * actually make.
 *
 * "When you are finished" reads as an ordering an agent is free to satisfy
 * loosely, and the card shows whichever report `TaskSettleService.findReport`
 * sees LAST — so a review drawn part-way through the work (a self-review
 * phase's `report_findings`, say) becomes the card's report, and the closing
 * summary written after it is never the thing on screen. REPORTED as a card
 * whose report was a mid-run code review rather than an account of the task.
 *
 * So it is stated as a position rather than as a moment, and the reason is
 * stated with it: an agent that knows an earlier report displaces its closing
 * one has a reason to hold the report back to the end.
 */
const REPORT_LAST =
  'Send that report as the LAST thing you do — after every other message and tool call, with nothing following it. The card shows whichever report comes last, so one drawn part-way through the work stands in place of your closing one.';
/**
 * The card's RESULT, and the one thing the agent has to do for the board to be
 * able to collect it.
 *
 * A task's work ends in a branch nobody has been shown. The run already carries
 * whatever pull requests it opened — `PullRequestCaptureService` reads them out
 * of the transcript on every turn end — and `TaskWire.pullRequests` is what
 * draws them on the card, so nothing here needs a tool of its own. What it does
 * need is for the pull request to EXIST and to be opened the one way that
 * capture can see.
 *
 * `gh pr create` is named for exactly that reason rather than as a suggestion:
 * the capture matches a tool call running that command paired with a result
 * carrying a `…/pull/<n>` URL, which is what keeps somebody else's pull request
 * — a `gh pr view`, a `git push` hint — from being filed as this card's work.
 * One opened through the web, or through `gh api`, is a real pull request that
 * the board will never show.
 *
 * CONDITIONAL on there being commits, because the alternative is worse than
 * silence: a card that asked a question, or one whose answer was "nothing needs
 * changing", would otherwise be closed with an empty pull request opened to
 * satisfy an instruction.
 */
const REPORT_PULL_REQUEST =
  'When the work leaves commits behind, open a pull request for it with `gh pr create` before you report, and give the link in the report. That command is also how the board attaches the pull request to the card as the result of the work, so one opened any other way will not appear there. Say in the report that there was nothing to open one for when that is the case.';
/**
 * The PICTURES of the work — screenshots of a UI change, a chart it produced —
 * and the one form the board can collect them in.
 *
 * Asked for because a card's report is otherwise words about a change nobody
 * has seen: the agent routinely HAS the screenshots (it took them to check its
 * own work), and they went no further than its scratch directory. A markdown
 * image with an ABSOLUTE path is named because that is the whole contract —
 * `TaskSettleService` reads the report and the closing message for exactly that
 * shape (`utils/report-images.ts`) and copies each image onto the card's files,
 * so it outlives the scratch directory the agent wrote it to. Anything else —
 * a bare path in prose, a relative one — is text the settle cannot tell from a
 * sentence that merely mentions a file.
 *
 * Conditional like the pull request, for the same reason: a card whose work has
 * nothing to look at must not be handed a screenshot taken to satisfy an
 * instruction.
 */
const REPORT_SCREENSHOTS =
  'When you took screenshots or produced images that show the result, reference each one in the report or your final message as a markdown image with its absolute path — `![what it shows](/absolute/path/to/image.png)`. Every image referenced that way is copied onto the task, so it stays with the card after the conversation is over.';
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
  REPORT_PULL_REQUEST,
  REPORT_SCREENSHOTS,
  REPORT_LAST,
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
  REPORT_PULL_REQUEST,
  REPORT_SCREENSHOTS,
  REPORT_LAST,
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
