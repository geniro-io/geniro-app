/**
 * Which tool calls are GENIRO'S OWN, and which of those draw a card.
 *
 * Its own module because two surfaces ask, from opposite ends of a call's life:
 * `transcript-groups.ts` hides the raw rows of a call that has ALREADY
 * happened, and `live-row.tsx` draws a placeholder while the model is still
 * WRITING one (the `composingTool` live field). A second copy of the matching
 * rule is how one of them would come to recognise a tool the other does not —
 * and the failure is silent in both directions: a raw envelope printed into the
 * transcript, or a card that appears with no loader before it.
 */

/**
 * The renderer's own agent-call tools ride the transcript as raw
 * tool_call/tool_result items too, but the dedicated call kinds
 * (call_started/call_result/call_question/call_answer/await_collected)
 * already tell that story in a readable form — the raw envelope JSON rows
 * are pure duplication, so they are hidden from the transcript. Every host tool
 * rides it for the same reason: each draws its own card — a findings table, a
 * chart, a scorecard, a decision table, a diff with Apply, a plan with Approve
 * — and the raw call beside it is the same row twice.
 *
 * A row STORED before geniro's server was renamed per run — claude published it
 * under this fixed key then, so old transcripts carry `mcp__geniro__<tool>` and
 * would otherwise start showing raw envelope rows on replay. Live turns are
 * matched by the run-scoped rule in {@link isGeniroToolName} instead.
 *
 * Paired with the TOOL NAMES rather than used as a bare prefix, because
 * `geniro` is a name a user's own MCP server may legitimately carry: matching
 * the prefix alone hid every call to THEIR server as well, so an agent would
 * work through it while the transcript showed nothing.
 */
const GENIRO_TOOL_PREFIX = 'mcp__geniro__';

/**
 * The CARD each drawing tool produces — the shape a placeholder should take
 * while the model is still writing the call.
 *
 * It is the union `isCardEntry` already ranges over, minus the kinds no tool
 * produces (a task list is announced, not called for), and it is what lets the
 * loader be the right size and rhythm for what is coming rather than one
 * generic spinner: an artifact resolves into a page, a scorecard into a row of
 * tiles.
 */
export type GeniroCardKind =
  | 'findings'
  | 'chart'
  | 'metrics'
  | 'comparison'
  | 'gallery'
  | 'artifact'
  | 'patch'
  | 'plan';

/**
 * The tools geniro publishes on its own server that tell their story ELSEWHERE
 * in the transcript — as call rows or as a card — so their raw rows are hidden.
 *
 * NOT every tool on that server, which is what the per-run rule below used to
 * hide. `get_task`, `update_task` and `notify_user` draw nothing of their own
 * (the board tools change a card on another screen; `notify_user` posts a
 * system banner), so hiding their rows left no trace at all. REPORTED as "you
 * should have used the tool, but I don't see that tool call in the chat at all"
 * — over a turn that had moved its card to Done through `update_task`, with
 * the call and its result both in the transcript, and nothing on screen
 * between the user's message and the answer.
 *
 * The VALUE is the card that tool draws, or null for one whose story is told by
 * the dedicated call kinds instead. Keeping both facts in one table is what
 * stops the hide list and the loader's list from drifting: a drawing tool added
 * to one is added to the other by construction.
 *
 * TWIN PARSER: the daemon's tool names — `HOST_*_TOOL` in
 * `apps/daemon/src/v1/agents/chat.types.ts` and the call tools in
 * `adapters/adapter.types.ts`. A tool added there that draws its own card
 * belongs here; one that draws nothing does not.
 */
const GENIRO_TOOLS: Readonly<Record<string, GeniroCardKind | null>> = {
  call_agent: null,
  await_agent: null,
  answer_agent: null,
  ask_user_question: null,
  report_findings: 'findings',
  // None of these five was ever published under the legacy fixed key — the
  // per-run rename shipped first — but they are listed with their siblings so
  // this list and the daemon's cannot drift, and so a transcript exported from
  // a build in between still hides them.
  show_chart: 'chart',
  show_metrics: 'metrics',
  show_comparison: 'comparison',
  show_gallery: 'gallery',
  show_artifact: 'artifact',
  propose_patch: 'patch',
  propose_plan: 'plan',
};

/** The bare tool names, for the matching below. */
const GENIRO_TOOL_NAMES = Object.keys(GENIRO_TOOLS);

/**
 * The bare tool a call NAMES, when it is one of geniro's own on geniro's own
 * server — under EITHER of that server's two names — else null.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/host-tool.ts` decides the same
 * question daemon-side, for the permission gate, and its doc block carries the
 * two-names contract both sides read from.
 *
 * The per-run half is what covers cursor, whose tool rows carry no `mcp__` name
 * at all — the CLI reports the pair as one prose label around the server name
 * geniro minted. The run id in that name is what makes the SERVER unforgeable;
 * the tool name is required beside it, the daemon's `isHostToolCall` rule,
 * because that server also publishes tools that draw nothing.
 */
export function geniroToolOf(name: string, runId: string): string | null {
  const server = `geniro-${runId.slice(0, 8)}`;
  return (
    GENIRO_TOOL_NAMES.find(
      (tool) =>
        name === `${GENIRO_TOOL_PREFIX}${tool}` ||
        name === `mcp__${server}__${tool}` ||
        (!name.startsWith('mcp__') &&
          name.includes(server) &&
          name.includes(tool)),
    ) ?? null
  );
}

/**
 * Whether a string names a card kind — the guard a row's renderer needs.
 *
 * A live row's payload is `unknown` by the same rule every other item's is, and
 * this is what stands between a value read off it and the exhaustive switch
 * that draws the silhouette. It is derived from {@link GENIRO_TOOLS} rather
 * than from a second list, so a card added to that table is recognised here
 * without a second edit.
 */
export function isGeniroCardKind(
  value: string | null,
): value is GeniroCardKind {
  return value !== null && GENIRO_CARD_KINDS.has(value);
}

const GENIRO_CARD_KINDS = new Set<string>(
  Object.values(GENIRO_TOOLS).filter(
    (kind): kind is GeniroCardKind => kind !== null,
  ),
);

/** Whether a tool call is one of geniro's own on geniro's own server. */
export function isGeniroToolName(name: string, runId: string): boolean {
  return geniroToolOf(name, runId) !== null;
}

/**
 * The card a tool call is about to draw, or null when it draws none.
 *
 * Null covers three different things on purpose — a tool of somebody else's
 * server, one of geniro's that draws no card, and a name nothing recognises —
 * because the caller does the same thing with all three: leave the transcript
 * exactly as it was.
 */
export function geniroCardKindOf(
  name: string,
  runId: string,
): GeniroCardKind | null {
  const tool = geniroToolOf(name, runId);
  return tool === null ? null : (GENIRO_TOOLS[tool] ?? null);
}
