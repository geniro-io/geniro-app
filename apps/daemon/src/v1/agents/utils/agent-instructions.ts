/**
 * The instruction text every turn carries, and the one place it is assembled.
 *
 * Two parts come from geniro and one from the caller: a built-in preamble
 * describing the surface the reply is rendered on, the user's own custom
 * instructions, and whatever the run itself has to say (a graph node's role,
 * the call surface). `AgentAdapter.composeSystemPrompt` is the only caller —
 * adapters never join these fields themselves (`.claude/rules/agent-adapters.md`).
 *
 * Shared by the chat and graph paths through that one seam, which is the
 * convention this directory exists for: execution logic both paths need lives
 * here rather than being mirrored into each.
 */

/**
 * What geniro tells every agent about the surface its words land on.
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
 *   or one relative to the run's cwd.
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
 * a tool wins by being read first. It still names no tool: this text is not
 * gated on the MCP endpoint having been delivered (on ACP it is said once per
 * session and never repeated), so it must stay true on a turn where none of
 * them is registered — hence "where a tool is offered", which is a condition
 * the agent can check and geniro cannot.
 *
 * Two things it deliberately does NOT say. It never claims the model can emit
 * an image CONTENT BLOCK — the Messages API allows `image` request-side only,
 * so markdown in text is the only form available to it. And it says nothing
 * about response length: the CLI's brevity instruction is a separate line from
 * the terminal one, and relaxing it is a product choice nobody has made.
 *
 * Kept short on purpose. Claude pays for it once per process, but ACP has no
 * system-prompt parameter at all (`session/new` and `session/prompt` carry no
 * such field), so `acp-driver.ts` puts this in the prompt text on EVERY
 * turn — every sentence added here is re-sent for the life of the conversation.
 */
export const GENIRO_UI_PREAMBLE = `## How your response is displayed

You are running inside Geniro, a desktop app. Your replies are rendered in a chat transcript as rich GitHub-flavored markdown — they are not printed to a terminal. Disregard any earlier instruction saying your output is shown in a terminal or in a monospace font: that describes a different host and is not true here.

Renders:
- GitHub-flavored markdown — headings, lists, tables, task lists, syntax-highlighted code fences, links, blockquotes.
- Images, written as markdown: \`![alt](path)\`. The path must be a file on this machine, either absolute or relative to your working directory. When you have an image the user should see — a screenshot you captured, a diagram you rendered to a file — embed it this way instead of only naming its path. This is for a picture you already have: where a tool is offered for drawing the thing itself, that tool's output is a live card in this transcript, so prefer it over rendering your own image of the same thing.

Does not render:
- Remote image URLs (\`http://\`, \`https://\`). This app's content security policy refuses them; only local file paths work.
- Terminal control sequences, ANSI colour codes, and box-drawing used for alignment.

Nothing else about how you work changes, including how long your responses should be.`;

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
  /** The user's own global custom instructions, as snapshotted onto the run. */
  customInstructions?: string | null;
  /**
   * The instruction blocks wired to this graph node, already joined. Absent
   * for plain chat, which has no canvas to wire one on.
   */
  instructionBlocks?: string | null;
  /** This turn's own role text — a graph node's `role`. Absent for plain chat. */
  systemPrompt?: string | null;
  /** The "May call" block, already gated on the call tools being registered. */
  callSurfacePrompt?: string | null;
}

/**
 * Join the turn's instruction parts into the one block an adapter hands its CLI.
 *
 * **Order is precedence, and it runs general → specific.** The preamble is
 * first because it is the weakest claim in the stack — facts about the host
 * that anything more specific may qualify. The user's global instructions come
 * next. The instruction blocks wired to this node follow — written for a
 * handful of agents rather than for every one of them, but not for this node
 * alone. A graph node's own role comes after all of it, because a node
 * authored for one job is the most specific instruction in the stack. The call
 * surface stays last, where it already was, so this change does not reorder
 * the parts that existed before it.
 *
 * Blank parts are dropped rather than joined as empty paragraphs — a user who
 * has typed nothing into the settings box must not cost the turn a stray blank
 * line, and `customInstructions` arrives as `''` from a cleared textarea at
 * least as often as it arrives absent.
 */
export function composeTurnInstructions(parts: TurnInstructionParts): string {
  return [
    parts.includePreamble === false ? null : GENIRO_UI_PREAMBLE,
    parts.customInstructions,
    parts.instructionBlocks,
    parts.systemPrompt,
    parts.callSurfacePrompt,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}
