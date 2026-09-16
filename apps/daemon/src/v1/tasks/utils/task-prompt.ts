import type { Task } from '../entity/task.entity';
import type { TaskFileWire } from '../tasks.types';

/** What the agent is told it is doing, in the same words for both engines. */
const REPORT_OPENING =
  'You are working a single task from a board. The card for it changes only through the `update_task` tool — nothing moves the card or writes its report for you when you stop.';
/**
 * The ask itself, and the reason it is a TOOL rather than the closing message.
 *
 * The card used to show whichever message the thread ended on, which is
 * whatever the agent happened to say last — a status line, a question, a
 * mid-run review — and the card moved to review the moment the run ended,
 * finished or not. So the agent now decides both: it writes the report and
 * picks the column, and a run ending by itself does neither.
 *
 * The columns are named with what each MEANS, because "move the card" alone
 * leaves every finished task in `done` and nothing in review.
 */
const REPORT_TOOL =
  'When the work is finished, call `update_task` with your full `report` and move the card with `status`: `in_review` when there is something for a person to review, `done` only when nothing is left to review, `failed` when you could not do the task (the report says why). Each call replaces the previous report, so send the whole account, not a delta. `get_task` reads the card as it stands now, in case the user moved it while you worked.';
const REPORT_CONTENT =
  'The report is markdown: what changed, what you verified, and anything you deliberately left undone.';
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
 * A markdown image with an ABSOLUTE path is named because that is the whole
 * contract: `update_task` reads the report for exactly that shape
 * (`utils/report-images.ts`), copies each image onto the card's files so it
 * outlives the scratch directory the agent wrote it to, and points the report
 * at the copy. Anything else — a bare path in prose, a relative one — is text
 * that cannot be told from a sentence that merely mentions a file.
 *
 * Conditional like the pull request, for the same reason: a card whose work has
 * nothing to look at must not be handed a screenshot taken to satisfy an
 * instruction.
 */
const REPORT_SCREENSHOTS =
  'When you took screenshots or produced images that show the result, reference each one in the report as a markdown image with its absolute path — `![what it shows](/absolute/path/to/image.png)`. Every image referenced that way is copied onto the task, so it stays with the card after the conversation is over.';
/** What to do on the rare CLI that could not be handed the endpoint. */
const REPORT_FALLBACK =
  'If the `update_task` tool is not available to you, say so in your final message and write the report there instead — the card will then wait for a person to move it.';

/**
 * What geniro asks a task's agent to do, on top of whatever the user's own
 * standing instructions already say.
 *
 * It rides the run's `taskInstructions` rather than the prompt,
 * because the prompt is what a CLI NAMES the conversation from: leading with
 * house-keeping had cursor-agent titling chats after geniro's own preamble
 * (see `AgentAdapter.composeSystemPrompt`), and the same would happen here.
 *
 * `update_task` is named rather than described because it is served on the
 * MCP endpoint every chat is handed, on either CLI, to any run that works a
 * card — so the ask carries no per-CLI branch.
 */
export const TASK_REPORT_INSTRUCTIONS = [
  REPORT_OPENING,
  REPORT_TOOL,
  REPORT_CONTENT,
  REPORT_PULL_REQUEST,
  REPORT_SCREENSHOTS,
  REPORT_FALLBACK,
].join('\n');

/**
 * The same ask, for a task run through a WORKFLOW — every node of which is
 * handed the board tools, so one sentence says which of them should use them.
 *
 * Without it every node would report: a fan-out of reviewers each replacing the
 * card's report with its own slice, and whichever wrote last standing as the
 * account of the whole task.
 */
export const TASK_REPORT_INSTRUCTIONS_WORKFLOW = [
  REPORT_OPENING,
  'You are one agent of a workflow working this task. Update the card only if your part concludes the work; an agent handing its result on to another leaves the card alone.',
  REPORT_TOOL,
  REPORT_CONTENT,
  REPORT_PULL_REQUEST,
  REPORT_SCREENSHOTS,
  REPORT_FALLBACK,
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
