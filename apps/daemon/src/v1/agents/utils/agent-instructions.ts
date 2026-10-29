/**
 * The instruction text every turn carries, and the one place it is assembled.
 *
 * A built-in preamble describing the surface the reply is rendered on, the
 * user's own custom instructions, what a board card asks of the run working it,
 * and whatever the turn itself has to say (a graph node's instruction blocks
 * and role, the call surface). Reached only through `AgentAdapter`
 * (`composeSystemPrompt`, and `turnInstructionParts` for the workflow
 * inspector's size readout) — adapters never join these fields themselves
 * (`.claude/rules/agent-adapters.md`).
 *
 * Shared by the chat and graph paths through that one seam, which is the
 * convention this directory exists for: execution logic both paths need lives
 * here rather than being mirrored into each.
 */

import { redactSecrets } from '../../diagnostics/utils/redact';

/**
 * What geniro tells every agent about the surface its words land on, and about
 * the tools of its own it offers there.
 *
 * **This exists to CONTRADICT the CLI's own system prompt, not merely to
 * inform.** Claude Code ships the line `- Text you output outside of tool use
 * is displayed to the user as Github-flavored markdown in a terminal.` (read
 * out of the installed 2.1.235 binary's own string table), and the channel
 * geniro has is `--append-system-prompt` — additive by construction, so the
 * terminal claim cannot be deleted, only argued with. That is why the second
 * paragraph names the false statement instead of just stating the true one: an
 * appended contradiction that does not say what it is contradicting reads as a
 * second opinion rather than a correction.
 *
 * Every claim in here is checked against this app's own renderer rather than
 * against a vendor doc, because the renderer is what decides:
 * - GFM renders — `markdown-content.tsx` is ReactMarkdown + remarkGfm.
 * - A markdown image with a LOCAL path renders — `markdown-image.tsx` resolves
 *   it through `GET /v1/chats/:runId/image?path=`, which takes an absolute path
 *   or one relative to the run's cwd. The bullet asks for the ABSOLUTE one
 *   regardless, and that is a REPORT rather than a preference: an agent wrote
 *   `![](out/ci723-assignee-rail.png)` and the transcript drew
 *   `could not read out/ci723-assignee-rail.png`, because the base a relative
 *   reference is measured against is the RUN's cwd and the agent had written
 *   the file somewhere else — routinely, since a delegate, a workflow node or
 *   a command run in a subdirectory all write relative to their own place. The
 *   route still accepts a relative path (old transcripts are full of them, and
 *   it is right when the two agree); the instruction simply stops recommending
 *   the form that can be wrong, since the agent is the one party that knows
 *   the absolute path for certain.
 * - A REMOTE image does not, and saying otherwise would be the one instruction
 *   here that produces a visibly broken transcript: the renderer's CSP is
 *   `img-src 'self' data:`, so an `http(s):` source is refused outright.
 *
 * The image bullet says "a picture you already have" for a reason that only
 * appeared once the host RENDER tools shipped (`show_chart` and its family):
 * as first written it told an agent with numbers in hand to render a chart to
 * a file and embed it, which is the same job one of those tools does properly —
 * a live card instead of a picture of one. The preamble leads the instruction
 * stack, so its phrasing is the default habit, and a default that competes with
 * a tool wins by being read first. Every tool it names is named conditionally:
 * this text is not gated on the MCP endpoint having been delivered (on ACP it
 * is said once per session and never repeated), and a workflow node is offered
 * only some of them, so it must stay true on a turn where none of them is
 * registered — hence "where a tool is offered" and "a tool missing from your
 * list is not offered", conditions the agent can check and geniro cannot.
 *
 * The tools section exists because a tool's own description is not read until
 * the agent reaches for the tool: claude lists MCP tools by name only and loads
 * a schema on demand, so nothing in its context said WHEN `monitor` or
 * `publish_action` was the move. Measured over this machine's 360 plain claude
 * chats from 2026-09-15 to 2026-10-28: a `sleep` polling loop in 161 of them
 * and a CI wait (`gh run watch`, `gh pr checks`) in 155, against geniro's
 * `monitor` in 1 (claude's own `Monitor`, before it was withheld, in 12),
 * `publish_action` in 3 and `notify_user` in none. So each line names a
 * situation and its tool, and leaves the how to the tool's description. The
 * `Monitor` sentence answers claude's own Bash tool, whose description and
 * `sleep` refusal (2.1.295) send the model to a `Monitor` tool geniro withholds
 * (`CLAUDE_WITHHELD_TOOLS`); it names no CLI, so elsewhere it says nothing.
 *
 * The paragraph about text BEFORE A TOOL CALL is the one claim here about the
 * API rather than the renderer, and it is measured: on Opus 5.5 (and Fable
 * 5.1) prose longer than a sentence or two that precedes a tool call comes
 * back as a progress-update `thinking` block, which Claude Code requests as
 * `display: "updates"` — a server-written SUMMARY of it. The full text is
 * returned under no display setting. A run on 2026-09-24 lost a whole plan
 * that way ahead of an AskUserQuestion: one sentence arrived out of ~2k
 * tokens, and the model then believed the user had read it. A tool's INPUT is
 * never summarized, so the question's own fields are the channel that
 * survives — which is why the renderer draws an option's `description` and
 * `preview` at all. Said as "may", because a CLI or model that returns the
 * prose as text makes it untrue, and the instruction costs nothing there.
 *
 * Two things it deliberately does NOT say. It never claims the model can emit
 * an image CONTENT BLOCK — the Messages API allows `image` request-side only,
 * so markdown in text is the only form available to it. And it says nothing
 * about response length: the CLI's brevity instruction is a separate line from
 * the terminal one, and relaxing it is a product choice nobody has made.
 *
 * Kept short on purpose. Claude pays for it once per process, but ACP has no
 * system-prompt parameter at all (`session/new` and `session/prompt` carry no
 * such field), so `acp-driver.ts` puts this in the prompt text — once per
 * session, where it then sits in the conversation's window for its whole life.
 */
export const GENIRO_UI_PREAMBLE = `## How your response is displayed

You are running inside Geniro, a desktop app. Your replies are rendered in a chat transcript as rich GitHub-flavored markdown — they are not printed to a terminal. Disregard any earlier instruction saying your output is shown in a terminal or in a monospace font: that describes a different host and is not true here.

Renders:
- GitHub-flavored markdown — headings, lists, tables, task lists, syntax-highlighted code fences, links, blockquotes.
- Images, written as markdown: \`![alt](/full/path/to/file.png)\`. Give the FULL path to a file on this machine, always — a relative path is measured against this conversation's own working directory, which is frequently not the directory you wrote the file in, and the picture then fails to load. When you have an image the user should see — a screenshot you captured, a diagram you rendered to a file — embed it this way instead of only naming its path. This is for a picture you already have: where a tool is offered for drawing the thing itself, that tool's output is a live card in this transcript, so prefer it over rendering your own image of the same thing.

Does not render:
- Remote image URLs in markdown (\`![](https://…)\`). This app's content security policy refuses them; only local file paths work there. Where \`show_gallery\` is offered, it takes a picture's URL itself.
- Terminal control sequences, ANSI colour codes, and box-drawing used for alignment.

Text you write before a tool call in the same response may reach the user only as a one-line summary, not in full. So when you ask the user a question, put everything they need to decide into the question itself — the question text, each option's description, and, where the question tool takes one, an option's preview, which is shown in full as markdown. Anything else the user must read in full goes in a message that ends your turn, with no tool call after it.

Nothing else about how you write your replies changes, including how long they should be.

## Geniro's own tools

Beside your CLI's tools, this app offers tools of its own, named below (in your tool list a name may carry a prefix naming this app's server). When a situation below comes up, use its tool rather than a workaround; the tool's own description says how. Where your CLI lists tools by name only, load the tool first. A tool missing from your list is not offered on this turn.

- \`monitor\`: waiting on something slow that reports as it goes — a CI run, a deploy, a long build or test run, a log line you need, or a condition you would otherwise re-check in a loop. Start it as a monitor and, with nothing else to do, end your turn: its output wakes you, so never poll it with sleep loops. Where your CLI's own instructions name a \`Monitor\` tool, this is the one to use.
- \`publish_action\`: a BUTTON in this chat. A press sends the message you gave it — to you, or in a workflow to the agent the user's messages go to — stops a process you left running, or runs a command once the user has confirmed it. Use it when your next step waits on something only the user will see happen, such as a pull request being merged; whenever you leave a server or watcher running for the user, so they can stop it once they are done with it; and for a step only they should decide to run.
- \`notify_user\`: once, at the very end, when you have finished but leave something running for the user, such as a dev server.
- \`show_chart\` for several readings of one thing, \`show_metrics\` for one current figure each of several things, \`show_comparison\` for options you weigh against the same criteria and pick between, \`show_gallery\` for several pictures that belong together: each draws a live card, so reach for it before writing the same data as a table, an ASCII chart or a list of paths.
- \`show_artifact\`: a PAGE of your own — an HTML document this app shows beside the conversation and opens full-screen, with your own layout and working interaction — for an answer to look at rather than read in order, such as a report or a dashboard.
- \`report_findings\`: the defects a code review found, all in one call.
- \`propose_plan\`: a plan the user approves before you start, when you have not been told to go ahead and the request could be read more than one way or touches something hard to undo. \`propose_patch\`: a change to one file you would rather hand the user to apply than make yourself.
- \`memory_search\`, then \`memory_read\`: a preference, convention, decision or command another agent may already have recorded — at the start of a task, and before you ask the user or guess. \`memory_save\`: one durable fact the next agent, on any CLI and in any later chat, would otherwise have to rediscover — a correction the user gave, a convention and its reason, a command that works; never a secret or your progress. \`memory_forget\`: an entry that turned out wrong.
- \`search_chats\`, then \`read_chat_context\`: an earlier decision, fix or context from another conversation.
- \`list_tasks\`, \`get_task\`, \`create_task\`, \`update_task\`: the user's task board, when they ask to find, file or change work on it.
- \`read_workflows\`, then \`propose_workflow\`: a saved team of agents (a workflow) the user asks you to build or change.`;

/**
 * The instruction parts one turn contributes, in the order they are joined.
 *
 * Separate optional fields rather than one pre-composed string, for the reason
 * `AgentTurnInput.callSurfacePrompt` already documents: a part can be
 * conditionally withheld (an adapter that could not deliver the call tools must
 * drop the block naming them), and a single string could not be.
 */
export interface TurnInstructionParts {
  /**
   * Whether this turn's reply lands on a surface the preamble describes.
   *
   * False for geniro's own capability probes (`AgentTurnInput.internalProbe`),
   * whose output the daemon parses and nobody reads — telling one about
   * markdown rendering states something untrue and pays argv for it. Defaults
   * to true, so a caller that forgets it gets the safe answer: an agent told
   * about a transcript it does have.
   */
  includePreamble?: boolean;
  /**
   * The CLI's own word on work left running when a turn ends
   * (`AdapterConfig.backgroundWork.agentNote`). Withheld with the preamble:
   * a probe has no turn to end and nothing to background.
   */
  backgroundWorkNote?: string | null;
  /**
   * The language the user wants replies in, as snapshotted onto the run.
   * Withheld with the preamble: a probe's output is parsed, never read.
   */
  replyLanguage?: string | null;
  /** The user's own global custom instructions, as snapshotted onto the run. */
  customInstructions?: string | null;
  /**
   * The shared memory's title index, as snapshotted onto `Run.memoryIndex`:
   * entries the user wrote, imported or approved, led by a line saying it is
   * data.
   */
  memoryIndex?: string | null;
  /**
   * What the board card this run works asks of it — its label instructions,
   * then geniro's report ask, as stored on `Run.taskInstructions`. Absent for
   * every run no card started.
   */
  taskInstructions?: string | null;
  /**
   * What geniro tells a workflow-editing chat about the file it owns, as
   * stored on `Run.workflowInstructions`. Absent for every run outside the
   * builder's chat panel.
   */
  workflowInstructions?: string | null;
  /**
   * The instruction blocks wired to this graph node, already joined. Absent
   * for plain chat, which has no canvas to wire one on.
   */
  instructionBlocks?: string | null;
  stageMapPrompt?: string | null;
  /** This turn's own role text — a graph node's `role`. Absent for plain chat. */
  systemPrompt?: string | null;
  /**
   * What a turn answering a call is told about where its answer goes — every
   * callee, whether or not it may call anyone itself. Not gated on the call
   * tools: it names none.
   */
  answeringACallPrompt?: string | null;
  /** The "May call" block, already gated on the call tools being registered. */
  callSurfacePrompt?: string | null;
}

/**
 * The sentence that names the user's reply language, or null when none is set.
 *
 * It names every English source in the window on purpose: a model surrounded
 * by English briefs, skills and tool output drifts into English without a rule
 * that says those do not decide the reply's language.
 */
export function replyLanguageInstruction(
  language: string | null | undefined,
): string | null {
  const name = language?.trim();
  if (!name) {
    return null;
  }
  return `Reply to the user in ${name}, whatever language these instructions, the files, the tools and your earlier replies are in. What you write into the project — code, comments in code, identifiers, file paths, commands, commit messages — stays in the language the project already uses.`;
}

/**
 * Where each part of a turn's instruction block comes from, in the order they
 * are joined. The workflow inspector's size readout names its rows by these.
 */
export const TURN_INSTRUCTION_SOURCES = [
  'preamble',
  'backgroundWorkNote',
  'replyLanguage',
  'customInstructions',
  'memoryIndex',
  'taskInstructions',
  'workflowInstructions',
  'instructionBlocks',
  'stageMap',
  'role',
  'answeringACall',
  'callSurface',
] as const;

export type TurnInstructionSource = (typeof TURN_INSTRUCTION_SOURCES)[number];

/** One non-blank part of a turn's instruction block, already trimmed. */
export interface TurnInstructionPart {
  source: TurnInstructionSource;
  text: string;
}

/** What separates two parts in the composed block. */
export const TURN_INSTRUCTION_SEPARATOR = '\n\n';

/**
 * The turn's instruction parts, each named by its source, trimmed, blank ones
 * dropped — what an adapter joins ({@link joinTurnInstructionParts}) into the
 * one block it hands its CLI, and what the workflow inspector measures, so the
 * block and its breakdown can never disagree.
 *
 * **Order is precedence, and it runs general → specific.** The preamble is
 * first because it is the weakest claim in the stack — facts about the host
 * that anything more specific may qualify. The CLI's note on background work
 * follows it: another fact about the host, this one per CLI. The user's reply
 * language comes next, ahead of their free text, so their own words can still
 * qualify it. The user's global
 * instructions come next, then the shared memory's index — notes the user
 * wrote or approved, which their standing instructions outrank — then what a board
 * card asks of the run working it —
 * its label instructions, written for a class of card, and the report ask that
 * run needs.
 * A workflow-editing chat's brief sits beside that one: same kind of claim (the
 * job geniro opened this run for), and a run is only ever one of the two, so
 * their relative order decides nothing.
 * The instruction blocks wired to this node follow — written for a
 * handful of agents rather than for every one of them, but not for this node
 * alone. A graph node's own role comes after all of it, because a node
 * authored for one job is the most specific instruction in the stack. A
 * callee's word on where its answer goes follows the role, and the call
 * surface stays last — its calls-specific half of that rule reads on from it.
 *
 * Blank parts are dropped rather than joined as empty paragraphs — a user who
 * has typed nothing into the settings box must not cost the turn a stray blank
 * line, and `customInstructions` arrives as `''` from a cleared textarea at
 * least as often as it arrives absent.
 */
export function turnInstructionParts(
  parts: TurnInstructionParts,
): TurnInstructionPart[] {
  const preamble = parts.includePreamble !== false;
  const candidates: [TurnInstructionSource, string | null | undefined][] = [
    ['preamble', preamble ? GENIRO_UI_PREAMBLE : null],
    ['backgroundWorkNote', preamble ? parts.backgroundWorkNote : null],
    [
      'replyLanguage',
      preamble ? replyLanguageInstruction(parts.replyLanguage) : null,
    ],
    ['customInstructions', parts.customInstructions],
    // Masked again on every turn: a secret registered after the run started
    // never rides a later turn's instructions.
    [
      'memoryIndex',
      parts.memoryIndex ? redactSecrets(parts.memoryIndex) : null,
    ],
    ['taskInstructions', parts.taskInstructions],
    ['workflowInstructions', parts.workflowInstructions],
    ['instructionBlocks', parts.instructionBlocks],
    ['stageMap', parts.stageMapPrompt],
    ['role', parts.systemPrompt],
    ['answeringACall', parts.answeringACallPrompt],
    ['callSurface', parts.callSurfacePrompt],
  ];
  const kept: TurnInstructionPart[] = [];
  for (const [source, text] of candidates) {
    const trimmed = text?.trim();
    if (trimmed) {
      kept.push({ source, text: trimmed });
    }
  }
  return kept;
}

/** The one block a list of {@link turnInstructionParts} composes to. */
export function joinTurnInstructionParts(
  parts: readonly TurnInstructionPart[],
): string {
  return parts.map((part) => part.text).join(TURN_INSTRUCTION_SEPARATOR);
}

/**
 * The common rough rule for English prose. A readout says "approximate"
 * because each model's tokenizer differs, and none of them is run here.
 */
const CHARS_PER_TOKEN = 4;

/** Roughly how many tokens an instruction text of `chars` characters takes. */
export function approxInstructionTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
