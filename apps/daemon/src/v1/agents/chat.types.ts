import { z } from 'zod';

import {
  AgentKindSchema,
  ItemKindSchema,
  type RunStatus,
  RunStatusSchema,
} from '../runs/runs.types';

/**
 * The single-agent chat has exactly one node; its CLI session id is keyed
 * under this constant in `node_state` (whose PK is runId+nodeId). `Item.nodeId`
 * stays null for single-agent transcript rows, per the entity contract. Shared
 * with the terminals module, which resolves the same key to `--resume` the
 * chat's CLI session in a live TUI.
 */
export const SINGLE_AGENT_NODE = 'agent';

/**
 * How long an auto-generated chat title may be.
 *
 * Well under the 200 the column and `RenameRunDto` allow: this is a sidebar row
 * and a header, and a title that has to be elided on screen every time was never
 * doing its job. Applied to a CLI's own title too — the ceiling is the app's,
 * not the producer's.
 */
export const CHAT_TITLE_MAX_CHARS = 60;

/**
 * How many later turns may re-ask a CLI for the title it has since written.
 *
 * A cursor conversation is named by its agent AFTER an exchange, so the first
 * turn's read routinely finds nothing and the derived title is written instead
 * — which, named once, would mean the agent-generated title never lands on a
 * chat started in this app. A few later turns re-ask, and only while the stored
 * title is still exactly what this app derived.
 *
 * Small on purpose: a title the agent has not written by the fifth turn is one
 * it is not going to write, and every attempt past that is a database read per
 * turn for the life of the conversation.
 */
export const CHAT_TITLE_UPGRADE_TURNS = 5;

/**
 * Chat-level tool-approval modes. `plan` is chat-only by design decision —
 * the graph node schema stops at `acceptEdits` (graphs.types.ts
 * ApprovalModeSchema). A run row whose `approval` is null predates the mode
 * selector and keeps the legacy behavior: no permission flags on the CLI.
 */
export const CHAT_APPROVAL_MODES = [
  'auto',
  'ask',
  'acceptEdits',
  'plan',
] as const;
export const ChatApprovalModeSchema = z
  .enum(CHAT_APPROVAL_MODES)
  .meta({ id: 'ChatApprovalMode' });
export type ChatApprovalMode = z.infer<typeof ChatApprovalModeSchema>;

/**
 * What a new chat starts in when the user expresses no preference — a PRODUCT
 * choice (ask before acting), not a CLI fact, which is why it lives here and
 * not on an adapter. A CLI that cannot honour it falls back to the `auto`
 * floor; see `ChatService.initialApproval`.
 */
export const CHAT_DEFAULT_APPROVAL: ChatApprovalMode = 'ask';

/** One probed claude permission mode's headless support verdict. */
export const ProbeStatusSchema = z
  .enum(['pass', 'fail', 'unknown'])
  .meta({ id: 'ProbeStatus' });
export type ClaudeModeProbeStatus = z.infer<typeof ProbeStatusSchema>;

/**
 * The claude arm of GET /v1/capabilities — whether the installed claude CLI
 * accepts the probed `--permission-mode` values headlessly. Keyed by
 * `claude --version`: a binary upgrade re-probes without a daemon restart,
 * and only a genuine pass/fail verdict is disk-cached (`unknown` — timeout,
 * spawn error — stays memory-only).
 */
export const ClaudeModesCapabilitySchema = z
  .object({
    acceptEdits: ProbeStatusSchema,
    plan: ProbeStatusSchema,
    version: z
      .string()
      .nullable()
      .describe('`claude --version` line the verdict is keyed by'),
    probedAt: z
      .number()
      .nullable()
      .describe('Epoch ms of the probe that produced this verdict'),
    reason: z
      .string()
      .nullable()
      .describe('One-liner for the degrade system item / builder warning'),
  })
  .meta({ id: 'ClaudeModesCapability' });
export type ClaudeModesCapability = z.infer<typeof ClaudeModesCapabilitySchema>;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/approval-card.tsx
 * MAX_ANSWER_LENGTH.
 *
 * Sanity cap on a question answer (M4) — it travels as ONE stdin control
 * line into the paused CLI turn. Enforced at BOTH ingress points of the
 * answer channel: the WS verdict (invalid/oversize → status:'invalid', request
 * remains pending) and the MCP answer_agent tool (oversize → INVALID_ARGS).
 */
export const MAX_ANSWER_LENGTH = 32_768;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/approval-card.tsx
 * MAX_QUESTION_HEADER_LENGTH.
 *
 * Sanity cap on one question's `header` — the short noun phrase the CLI's own
 * picker uses as a tab title (claude documents 12 characters; this leaves room
 * for drift). A version-drifted payload could put a whole paragraph there, and
 * the renderer's tab strip has no truncation of its own, so an unbounded header
 * would push the answer controls off the card.
 */
export const MAX_QUESTION_HEADER_LENGTH = 64;

/**
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx — the third name
 * in `ApprovalCard`'s router.
 *
 * The tool geniro REGISTERS for a CLI that gives its own model no way to ask
 * the user anything ({@link AdapterConfig.hostQuestionToolReason}). It is
 * served over the run's MCP endpoint, so the agent sees it beside its other
 * MCP tools, and its input is deliberately the shape claude's own
 * AskUserQuestion takes — the renderer already parses that, so a host-asked
 * question renders through the same card as a CLI-asked one rather than
 * through a second one free to disagree with it.
 *
 * The name is geniro's, not any CLI's, which is why it lives here rather than
 * in an adapter: the whole point is that no adapter owns it.
 */
export const HOST_QUESTION_TOOL = 'ask_user_question';

/**
 * Sanity cap on one host-asked question's option count and question count.
 * A model is free to send more; the cap is what stops a card from becoming a
 * scrolling wall the answer controls sit below.
 */
export const MAX_HOST_QUESTIONS = 4;
export const MAX_HOST_QUESTION_OPTIONS = 8;

/** One option of a host-asked question. */
export interface HostQuestionOption {
  label: string;
  description?: string;
}

/** One question of a host-asked `ask_user_question` call. */
export interface HostQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: HostQuestionOption[];
}

/**
 * What a host-asked question resolves to.
 *
 * `answered` carries the user's words; `declined` is a Deny verdict; and
 * `unavailable` is every way the ask could not be PUT — no turn to park, the
 * turn settled underneath it, the card could not be persisted. The three are
 * separate because the agent must be able to tell "they said no" from "nobody
 * was asked", and a tool that answered both with an empty string would have
 * the model treat an unasked question as a refusal.
 */
export type HostQuestionOutcome =
  | { status: 'answered'; answer: string }
  | { status: 'declined' }
  | { status: 'unavailable'; reason: string };

/**
 * TWIN PARSER: apps/ui/src/renderer/chats/findings-payload.ts — the reader over
 * the `report_findings` item payload this tool produces.
 *
 * The second tool geniro registers on the run's own MCP server. It exists so an
 * agent can hand the APP a typed list of findings and have the transcript draw
 * them, instead of printing markdown the transcript shows as prose. The findings
 * never re-enter the model's context: the call answers with a short receipt, and
 * the data lives in the item the renderer reads.
 *
 * The ARGUMENT shape deliberately mirrors claude's own `ReportFindings` tool,
 * snake_case field names included, so an agent that has learned one already
 * knows this one. The daemon's own types are camelCase; `readHostFindingsReport`
 * is the one place that seam is crossed.
 *
 * Unlike {@link HOST_QUESTION_TOOL} this is NOT registered only for a CLI that
 * lacks its own: a host-rendered card is a property of THIS app's transcript,
 * which no CLI can produce for itself.
 */
export const HOST_FINDINGS_TOOL = 'report_findings';

/**
 * Caps on one report. They TRUNCATE rather than refuse, on the same rule the
 * question caps above follow: a model that found forty things has still done
 * the work, and failing the call would leave it no way to report at all.
 */
export const MAX_HOST_FINDINGS = 32;
export const MAX_FINDING_TEXT_LENGTH = 4000;
export const MAX_FINDING_SHORT_SUMMARY_LENGTH = 60;
export const MAX_FINDING_CATEGORY_LENGTH = 40;
export const MAX_FINDING_PATH_LENGTH = 1024;

export const FINDING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];

export const FINDING_VERDICTS = ['CONFIRMED', 'PLAUSIBLE'] as const;
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];

export const FINDING_OUTCOMES = [
  'fixed',
  'skipped',
  'no_change_needed',
] as const;
export type FindingOutcome = (typeof FINDING_OUTCOMES)[number];

/** One finding of a host-rendered report. */
export interface HostFinding {
  file: string;
  line?: number;
  summary: string;
  /** The collapsed label — short because it shares one row with a badge. */
  shortSummary?: string;
  /**
   * Optional here though the tool advertises it as required: the reader is
   * defensive, and a finding that named a real defect without spelling out how
   * it fails is worth a row rather than being dropped whole.
   */
  failureScenario?: string;
  category?: string;
  /** Present only where the agent ran a verification pass over the finding. */
  verdict?: FindingVerdict;
  /** Present only on a RE-report, after the agent acted on its own findings. */
  outcome?: FindingOutcome;
}

/** One `report_findings` call, as the card will draw it. */
export interface HostFindingsReport {
  level?: FindingLevel;
  findings: HostFinding[];
}

/**
 * What a findings report resolves to.
 *
 * Two arms where a question has three: nothing here is put to the user, so
 * there is no `declined`. `unavailable` is every way the report could not be
 * RECORDED — no turn to file it against, the turn settled underneath it — and
 * stays separate from `recorded` so the agent can tell a card nobody will see
 * from one that is now on screen.
 */
export type HostFindingsOutcome =
  | { status: 'recorded'; count: number }
  | { status: 'unavailable'; reason: string };

/**
 * TWIN PARSER: apps/ui/src/renderer/chats/chart-payload.ts — the reader over the
 * `show_chart` item payload this tool produces.
 *
 * The third tool geniro registers on the run's own MCP server, and the second
 * of the RENDER family — an agent hands over typed numbers and this app plots
 * them, instead of spending its output on an ASCII bar chart or a markdown table
 * the reader has to hold in their head. Same bargain as the findings tool: the
 * data goes to the screen, the call answers with a receipt, and nothing
 * re-enters the model's context.
 *
 * Nothing here mirrors a claude tool, because claude has none — this is
 * geniro's own shape, and the snake_case argument names exist only for
 * consistency with the tool beside it. {@link readHostChart} is again the one
 * place that seam is crossed.
 */
export const HOST_CHART_TOOL = 'show_chart';

/**
 * The plot kinds the card can draw.
 *
 * Three, and no pie. A pie encodes magnitude as angle, which is the hardest
 * encoding to compare by eye, and everything it is reached for — "share of the
 * bundle by package" — reads better as the bar chart already here. Adding a
 * kind later is a line in this tuple plus a branch in the card; adding one now
 * that nobody asked for is a worse chart nobody can un-draw.
 */
export const CHART_KINDS = ['line', 'bar', 'area'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/**
 * Caps on one chart. They TRUNCATE rather than refuse, like every cap above.
 *
 * `MAX_CHART_SERIES` is 5 because the palette is five tokens
 * (`--chart-1..5`) and `categoryToken` WRAPS past the end. Wrapping is right
 * where each row carries its own label, which is what that helper was written
 * for; on a multi-series plot colour is the only thing tying a curve to its
 * legend entry, so a sixth series would be a second curve claiming the first
 * one's colour. Truncating is the honest failure: five plotted and said so,
 * rather than six drawn ambiguously.
 */
export const MAX_CHART_SERIES = 5;
export const MAX_CHART_POINTS = 200;
export const MAX_CHART_TITLE_LENGTH = 120;
export const MAX_CHART_LABEL_LENGTH = 40;

/**
 * One plotted series: a name, and one value per x label.
 *
 * `values` is positional against {@link HostChart.labels} rather than a list of
 * `{x, y}` pairs, and that is the whole reason this shape was chosen: a model
 * filling parallel arrays cannot silently disagree with itself about the
 * x axis, and a length mismatch is mechanically detectable where a set of
 * pair-lists with drifting x values is not.
 *
 * A null is a GAP — a point that was not measured — and is drawn as a break in
 * the curve rather than as zero, which would read as a measurement of nothing.
 */
export interface HostChartSeries {
  name: string;
  values: (number | null)[];
}

/** One `show_chart` call, as the card will plot it. */
export interface HostChart {
  /**
   * Optional here though the tool advertises it as required, on the reasoning
   * {@link HostFinding.failureScenario} follows: a plot of real numbers is
   * worth drawing under a generic heading, where dropping it over a missing
   * caption would throw away the measurement itself.
   */
  title?: string;
  kind: ChartKind;
  /** The x-axis categories; every series is read positionally against these. */
  labels: string[];
  series: HostChartSeries[];
  /** Axis captions. Absent where the numbers speak for themselves. */
  xLabel?: string;
  yLabel?: string;
}

/**
 * What a chart resolves to.
 *
 * Two arms, like the findings report and for the same reason — nothing is put
 * to the user, so there is no `declined`. The counts are in the receipt because
 * the caps above TRUNCATE silently otherwise: an agent that sent seven series
 * and reads back "5 series" learns what happened without the findings ever
 * being echoed.
 */
export type HostChartOutcome =
  | { status: 'drawn'; series: number; points: number }
  | { status: 'unavailable'; reason: string };

/**
 * TWIN PARSER: apps/ui/src/renderer/chats/metrics-payload.ts — the reader over
 * the `show_metrics` item payload this tool produces.
 *
 * The render family's SCORECARD: a handful of headline figures with their
 * changes, for the agent that has just measured a few things and would
 * otherwise write them into a sentence nobody can scan. Same bargain as its
 * siblings — the payload is the card, the call answers with a receipt, and the
 * figures never re-enter the model's context.
 *
 * The line against {@link HOST_CHART_TOOL} is worth stating, because an agent
 * with numbers in hand has to choose: a chart shows a SHAPE — a trend, or one
 * quantity across several categories — and needs several points per series to
 * show anything at all. A scorecard shows the CURRENT VALUE of unrelated
 * quantities, which a chart cannot do: coverage, bundle size and test count
 * share no axis, and plotting them together produces one enormous bar and two
 * invisible ones. So: several readings of ONE thing is a chart; one reading
 * each of several things is this.
 *
 * TWO facts about the shape are load-bearing.
 *
 * 1. **Every figure arrives ALREADY FORMATTED, as a string.** Only the agent
 *    knows whether `0.82` reads `82%` and whether `1258291` is `1.2 MB` or
 *    `1,258,291`, so formatting host-side would be guessing — and a scorecard
 *    that guesses wrong is worse than no scorecard, because it looks
 *    authoritative. This row displays; it never computes. That is also why
 *    there is no `unit` field beside the value: a unit is part of how a figure
 *    reads, and splitting it out only invites the two to be joined wrong.
 * 2. **The sentiment is STATED, never derived.** Whether a change is good news
 *    is not a property of its sign: `-40ms` is good and `-4% coverage` is bad.
 *    A host that coloured by sign would be confidently wrong half the time, and
 *    a `higherIsBetter` flag only moves the same guess one step away. The agent
 *    knows what it measured, so it says.
 */
export const HOST_METRICS_TOOL = 'show_metrics';

/**
 * Is this good news, bad news, or neither — the one question a card cannot work
 * out for itself, so the agent states it. It governs COLOUR and nothing else,
 * and `neutral` is both the default and a perfectly good answer.
 *
 * ONE vocabulary, shared by {@link HOST_METRICS_TOOL}'s deltas and
 * {@link HOST_COMPARISON_TOOL}'s cells, because they ask the identical
 * question of the host: which of three ways should this be painted. Named for
 * the question rather than for either tool — it was `METRIC_SENTIMENTS` while
 * only one tool asked — so the second caller did not have to choose between a
 * misleading name, an alias, and a duplicate tuple free to drift.
 */
export const SENTIMENTS = ['good', 'bad', 'neutral'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/**
 * Caps on one scorecard. They TRUNCATE, like every cap in this family except
 * the patch tool's.
 *
 * The count is where a scorecard stops being scannable at a glance, which is
 * the only thing it does better than a sentence — past that the figures want a
 * table, and a card claiming to be the headline numbers while listing twenty of
 * them is a worse table.
 */
export const MAX_HOST_METRICS = 8;
export const MAX_METRIC_LABEL_LENGTH = 60;
export const MAX_METRIC_VALUE_LENGTH = 24;
export const MAX_METRIC_NOTE_LENGTH = 120;

/** One figure on the scorecard. */
export interface HostMetric {
  /** What is being measured — the caption under the figure. */
  label: string;
  /** The figure AS IT SHOULD READ. Formatted by the agent; see above. */
  value: string;
  /** The change, also already formatted (`+4 pts`, `−120 kB`). Absent = none. */
  delta?: string;
  /**
   * What that change means. Absent is `neutral` — said as an absence rather
   * than a default written in, so the reader of a payload can tell "the agent
   * said neutral" from "the agent said nothing", which the card draws alike but
   * a future consumer may not want to.
   */
  sentiment?: Sentiment;
  /** One line of context under the figure, where the number needs one. */
  note?: string;
}

/** One `show_metrics` call, as the card will draw it. */
export interface HostMetrics {
  /** What the figures are ABOUT — the card's heading. */
  title?: string;
  metrics: HostMetric[];
}

/**
 * What a scorecard resolves to.
 *
 * Two arms, like the findings report and the chart: nothing is put to the user
 * to decide, so there is no `declined`. The count is in the receipt because the
 * cap above truncates silently otherwise — an agent that sent twelve figures
 * and reads back "8 figures" learns what happened without them being echoed.
 */
export type HostMetricsOutcome =
  | { status: 'drawn'; count: number }
  | { status: 'unavailable'; reason: string };

/**
 * TWIN PARSER: apps/ui/src/renderer/chats/comparison-payload.ts — the reader
 * over the `show_comparison` item payload this tool produces.
 *
 * The render family's DECISION TABLE: several options, judged against the same
 * criteria, with a recommendation. What an agent reaches for when it has been
 * asked "which of these should I use".
 *
 * **This one has to justify itself against markdown**, which its siblings do
 * not, because a markdown table RENDERS in this transcript — an agent can
 * already draw three columns of prose and it will look fine. So the card only
 * earns its place by holding what a table cannot:
 *
 * 1. A per-cell VERDICT, on the shared {@link SENTIMENTS} vocabulary. That is
 *    what makes the thing scannable — the winning option's column is visibly
 *    greener — where a markdown table forces the reader through every cell to
 *    work out the same answer.
 * 2. A RECOMMENDATION, named and reasoned. A comparison that does not answer
 *    the question it was asked has made the reader do the deciding, which is
 *    the work they delegated. It is optional, because "these are genuinely
 *    equivalent, it depends on X" is a real answer — but it is asked for.
 *
 * Take those two away and this tool should not exist; the agent should write a
 * table. The tool description says so, so a model can tell the two apart.
 *
 * **The cells are POSITIONAL**, the chart's hazard again and handled the same
 * way: a criterion's `cells` are matched to `options` BY INDEX, so nothing on
 * either side of the wire may drop or reorder one list independently of the
 * other. `readHostComparison` re-aligns every row to the option count — padding
 * short rows with blanks, cutting long ones — rather than trusting the model to
 * have counted, because that failure does not throw: it silently files one
 * option's answer under another's name and still looks like a comparison.
 */
export const HOST_COMPARISON_TOOL = 'show_comparison';

/**
 * Caps on one comparison. They TRUNCATE, like the rest of this family bar the
 * patch tool.
 *
 * FOUR options is where a side-by-side stops being side-by-side in a
 * transcript column — the fifth is what makes the table scroll horizontally,
 * and a comparison you have to scroll is a table again. The criteria cap is
 * where the reader stops holding the whole grid at once.
 */
export const MAX_COMPARISON_OPTIONS = 4;
export const MAX_COMPARISON_CRITERIA = 8;
export const MAX_COMPARISON_LABEL_LENGTH = 60;
export const MAX_COMPARISON_CELL_LENGTH = 120;
/**
 * The reason is the one PROSE field in this family — everywhere else a cap
 * bounds a phrase, and here the model is asked for a sentence or two. So it is
 * both roomier than its neighbours and cut differently: see `truncateWords`,
 * which is what a live turn made necessary by ending a recommendation
 * "…and where migrati".
 */
export const MAX_COMPARISON_REASON_LENGTH = 400;

/** One option being compared — a column of the table. */
export interface HostComparisonOption {
  /** The option's name, as its column heading. */
  name: string;
  /** One line under the heading, where the name alone is not enough. */
  note?: string;
}

/** One option's answer for one criterion. */
export interface HostComparisonCell {
  /** What this option does about this criterion, already worded. */
  value: string;
  /** How that reads for this option — colour only. Absent is `neutral`. */
  verdict?: Sentiment;
}

/** One criterion — a row of the table, one cell per option, BY INDEX. */
export interface HostComparisonCriterion {
  label: string;
  cells: HostComparisonCell[];
}

/** One `show_comparison` call, as the card will draw it. */
export interface HostComparison {
  /** What is being decided — the card's heading. */
  title: string;
  options: HostComparisonOption[];
  criteria: HostComparisonCriterion[];
  /**
   * The answer, when there is one.
   *
   * `option` is matched to a column BY NAME rather than by index — a model
   * writing "SQLite" is far more reliable than one writing `1`, and a name that
   * matches nothing costs only the column highlight while the reason still
   * reads. An index that pointed at the wrong column would be silently wrong.
   */
  recommendation?: { option: string; reason: string };
}

/**
 * What a comparison resolves to.
 *
 * Two arms, like the other drawings: nothing is put to the user to decide, so
 * there is no `declined`. The counts are in the receipt because the caps
 * truncate silently otherwise.
 */
export type HostComparisonOutcome =
  | { status: 'drawn'; options: number; criteria: number }
  | { status: 'unavailable'; reason: string };

/**
 * The render family's third tool, and the first that is not only a drawing.
 *
 * An agent proposes a change it has NOT made: the transcript shows the diff
 * with Apply and Reject, and geniro writes the file if the user presses Apply.
 * That is the whole point of it — an agent working under `ask` can hand over a
 * fix without holding a write gate open, and an agent that is not allowed to
 * edit at all can still be useful.
 *
 * THREE ways this one is not like its siblings, each load-bearing:
 *
 * 1. It PARKS. `report_findings` and `show_chart` are fire-and-forget; this one
 *    resolves only when the user answers, so it uses the same parked-promise
 *    machinery as {@link HOST_QUESTION_TOOL} — and, like it, rides an ordinary
 *    `approval_request` row rather than inventing a second card channel.
 * 2. It carries a REAL gate, and exactly one. The tool CALL auto-approves like
 *    its siblings' — calling it writes nothing, it only puts a diff on screen —
 *    while the Apply press on that diff is what reaches the disk. Getting this
 *    backwards puts a meaningless "allow propose_patch?" card in front of the
 *    meaningful one, which is what a live turn did before the auto-approve arm
 *    existed.
 * 3. Its caps REFUSE rather than truncate. Every cap above truncates, because a
 *    model that found forty things has still done the work. Truncating a patch
 *    would write a TRUNCATED FILE — the one place where taking the first N
 *    characters is worse than answering "too large".
 *
 * The argument names are `Edit`'s (`file_path` / `old_string` / `new_string`)
 * and deliberately so: an agent that knows that tool needs to learn nothing,
 * and the renderer's `editDiffOf` already draws exactly this shape, so the card
 * gets its diff without a second diff renderer.
 */
export const HOST_PATCH_TOOL = 'propose_patch';

/**
 * Refusal thresholds, not truncation points — see (3) above.
 *
 * The text cap is per side and generous: it has to hold a whole new file, since
 * a patch with no `old_string` IS a file creation.
 */
export const MAX_PATCH_TEXT_LENGTH = 200_000;
export const MAX_PATCH_PATH_LENGTH = 1024;
export const MAX_PATCH_SUMMARY_LENGTH = 200;

/** One `propose_patch` call, as the card will show it. */
export interface HostPatch {
  /** Where the change goes, resolved against the run's own cwd. */
  filePath: string;
  /**
   * The exact text being replaced, or absent to write the file WHOLE.
   *
   * Absent is `Write`'s shape — a new file, or a deliberate full rewrite — and
   * the renderer already draws that as additions only.
   */
  oldString?: string;
  newString: string;
  /** One line saying what the change does; the card's heading. */
  summary?: string;
}

/**
 * What a proposed patch resolves to.
 *
 * Four arms, and `stale` is the one that earns its place: the user said YES and
 * the write still could not happen — the file no longer holds the text the
 * agent matched on, it holds it twice, or the path is one this app will not
 * write to. Folding that into `declined` would tell the agent its fix was
 * rejected when it was in fact accepted, and folding it into `unavailable`
 * would hide that the right move is to look at the file again and re-propose.
 * The `reason` is what separates the cases.
 */
export type HostPatchOutcome =
  | { status: 'applied'; path: string }
  | { status: 'declined' }
  | { status: 'stale'; reason: string }
  | { status: 'unavailable'; reason: string };

/**
 * The render family's fourth tool: a plan put to the user BEFORE the work.
 *
 * An agent that has understood a request and worked out how it intends to carry
 * it out shows the steps and waits for a go-ahead. What that buys is the
 * cheapest correction there is — a plan is redirected in one sentence, while
 * the same misunderstanding found after the edits costs a revert.
 *
 * Structurally this is {@link HOST_PATCH_TOOL}'s twin: it PARKS on an ordinary
 * `approval_request` row, its CALL auto-approves (proposing changes nothing), and
 * the press on the card is the only gate. Three things are its own:
 *
 * 1. Approving performs NO action. A patch's Apply writes a file; a plan's
 *    Approve is the answer itself, and the work that follows is the agent's own
 *    ordinary turn. So there is no `stale` arm — nothing can have moved
 *    underneath a decision that touches nothing.
 * 2. Both verdicts carry an optional NOTE, and that is where most of this tool's
 *    value is. "No" alone tells an agent nothing and costs a round trip to ask
 *    what the user would rather have; "no — leave the parser alone, just fix the
 *    cap" redirects it in the same press. It rides the `answer` field the
 *    approval channel already carries for questions.
 * 3. It is not a question, and is tracked as `question: false` like the patch
 *    tool. The badge then reads "waiting for approval", which is what a card
 *    whose primary controls are Approve and Reject actually wants — the note is
 *    an addition to a verdict, not the verdict itself.
 *
 * Deliberately NOT a to-do list: nothing here is ticked off as the agent works.
 * A live checklist is a different feature with its own update channel, and
 * pretending this one is that would leave every plan frozen at step one.
 */
export const HOST_PLAN_TOOL = 'propose_plan';

/**
 * Truncation points, on the findings tool's rule rather than the patch tool's:
 * a plan that overran is still a plan, and showing fifteen of its steps beats
 * refusing the call. The step cap is where a plan stops being readable at a
 * glance, which is the only thing this card is better at than prose.
 */
export const MAX_PLAN_STEPS = 15;
export const MAX_PLAN_TITLE_LENGTH = 200;
export const MAX_PLAN_STEP_TITLE_LENGTH = 200;
export const MAX_PLAN_STEP_DETAIL_LENGTH = 600;

/** One step of a proposed plan, as its own row on the card. */
export interface HostPlanStep {
  /** What the step does, in one line — the row's own text. */
  title: string;
  /** The sentence or two under it, where one is worth reading. */
  detail?: string;
}

/** One `propose_plan` call, as the card will show it. */
export interface HostPlan {
  /** What the plan is FOR — the card's heading. */
  title: string;
  steps: HostPlanStep[];
}

/**
 * What a proposed plan resolves to.
 *
 * Three arms, one fewer than the patch tool's: approving a plan performs no
 * action, so nothing can go `stale` between the press and the effect. The note
 * hangs off BOTH verdicts because a user who approves with a caveat is telling
 * the agent something it must not lose.
 */
export type HostPlanOutcome =
  | { status: 'approved'; note?: string }
  | { status: 'declined'; note?: string }
  | { status: 'unavailable'; reason: string };

/**
 * Image types a pasted attachment may carry. Restricted to what the model APIs
 * behind both CLIs accept, so an unsupported paste is refused at the daemon
 * edge with a clear error rather than reaching an agent that silently ignores
 * it. Clipboard images from macOS screenshots are PNG.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export const AttachmentMediaTypeSchema = z
  .enum(ATTACHMENT_MEDIA_TYPES)
  .meta({ id: 'AttachmentMediaType' });
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

/**
 * TWIN LIMIT: apps/ui/src/renderer/chats/use-attachments.ts.
 *
 * Per-image and per-message caps. A pasted screenshot is well under a
 * megabyte; the ceiling exists because the bytes ride one JSON body and are
 * then held in memory as base64 for the CLI payload, so an unbounded paste is
 * a daemon OOM. Enforced at the daemon edge — the renderer's matching cap is a
 * courtesy that keeps the user from composing a message that will be refused.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * Ceiling on the user's global custom instructions, in characters.
 *
 * The value reaches a spawned child as argv (claude's `--append-system-prompt`)
 * and as prompt text (ACP), so it is bounded on both counts. macOS `ARG_MAX` is
 * 1 MiB and Linux is comparable, and the CLI's own argv carries flags,
 * a cwd and the composed block's other parts besides — 16k leaves that whole
 * budget untouched while sitting far above any prose a person types into a
 * settings box. Beyond argv there is a second reason to bound it at all: every
 * character here is re-sent to cursor on EVERY turn, since ACP has no
 * system-prompt slot to say it once.
 *
 * Enforced at the daemon edge (`createChatSchema`); the renderer's matching
 * cap is a courtesy that stops the user composing something that would be
 * refused, exactly like the attachment caps above.
 *
 * TWIN PARSER: `MAX_CUSTOM_INSTRUCTIONS_CHARS` in
 * `apps/ui/src/shared/contracts.ts`. The generated client carries the field's
 * type but not its `maxLength`, so the renderer cannot derive this number from
 * the wire and holds its own copy. This one is the ENFORCING side; change one,
 * change the other.
 */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 16_000;

/**
 * Whether a custom-instructions value carries a control character.
 *
 * A SIZE bound is not enough here because the sink is a child process's argv.
 * Node refuses a NUL outright: passing one to `spawn` throws
 * `ERR_INVALID_ARG_VALUE` SYNCHRONOUSLY, before any request is made. And the
 * value is snapshotted onto the run, so that throw would repeat on every turn
 * of that chat forever — one invisible character pasted into a settings box
 * would permanently brick every conversation started after it, with nothing on
 * screen to say why.
 *
 * Every C0 code point counts EXCEPT tab, newline and carriage return, which are
 * ordinary in prose and which a multi-line instruction needs.
 *
 * A code-point scan rather than a regex, deliberately. A character class
 * covering this range is either written with raw bytes — which makes git
 * classify the whole file as binary, and the `pre-commit` hook refuses it — or
 * with escapes, which eslint's `no-control-regex` flags either way. The scan
 * has neither problem and reads as what it is.
 */
export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

/**
 * The ONE validator for a custom-instructions value arriving on the wire.
 *
 * Exported as a schema rather than as two constants each route re-composes:
 * the size bound and the control-character refusal are a single rule about
 * what may reach a child's argv, and a route spelling only half of it is the
 * same silent asymmetry that already let the workflow path ship wired to
 * nothing. Both entry points say `CustomInstructionsSchema.optional()`, so a
 * later tightening lands on both by construction rather than by memory.
 */
export const CustomInstructionsSchema = z
  .string()
  .max(MAX_CUSTOM_INSTRUCTIONS_CHARS)
  .refine(
    (value) => !hasControlCharacters(value),
    'must not contain control characters',
  );

/**
 * The HTTP body ceiling the daemon hands Fastify (`main.ts`), DERIVED from the
 * two limits above rather than chosen.
 *
 * It is derived because the two are one promise, and they had been made by
 * different files that never checked each other: the schema accepts eight 5MB
 * images while Fastify's own default `bodyLimit` is 1MB, so a message carrying
 * eight pasted screenshots was refused by the transport 40x below the size the
 * app had just told the user was fine. What that produced was not even a
 * refusal about attachments — it was `413 {"code":"INTERNAL_SERVER_ERROR",
 * "message":"Request body is too large"}`, raised before any route ran, so the
 * per-image and per-message errors written for exactly this case could never be
 * reached. Reported with the envelope pasted verbatim into the chat.
 *
 * A named constant computed from its inputs is what stops that recurring:
 * raising `MAX_ATTACHMENTS_PER_MESSAGE` now raises the transport with it, and
 * nobody has to know this line exists.
 *
 * Base64 is 4 bytes per 3, and the slack on top covers the JSON scaffolding and
 * the message TEXT, which the schema deliberately does not bound (a pasted log
 * is a legitimate message). Generous rather than tight on purpose: the daemon
 * is loopback-only and single-user, and it already accepts holding this much
 * base64 in memory for the CLI payload — the ceiling exists to bound a runaway
 * body, not to second-guess a limit stated one line above it.
 */
export const MAX_REQUEST_BODY_BYTES =
  Math.ceil((MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS_PER_MESSAGE * 4) / 3) +
  1024 * 1024;

/**
 * Ceiling on an image an agent referenced from its own markdown
 * ({@link LocalImageService}).
 *
 * Separate from {@link MAX_ATTACHMENT_BYTES} and larger, because the two bound
 * different risks. That one caps what a user PASTES into a message the daemon
 * must hold in memory as base64 and hand to a CLI; this one caps what the
 * renderer will draw, and the file is one the agent produced — a full-window
 * screenshot at 2x comfortably exceeds 5MB, and refusing to display it would
 * be the same broken image by another route.
 */
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** One markdown-referenced image, read off disk for display. */
export const LocalImageWireSchema = z.object({
  path: z
    .string()
    .describe(
      'the reference exactly as the agent wrote it — the renderer’s cache key',
    ),
  mediaType: AttachmentMediaTypeSchema,
  data: z.string().describe('base64-encoded image bytes'),
});
// No `.meta({ id })`: this is a response DTO ROOT — same rule, and same reason,
// as `ChatMetricsWireSchema` below.
export type LocalImageWire = z.infer<typeof LocalImageWireSchema>;

/**
 * How much of a background command's output file is served at once.
 *
 * The TAIL, not the head, and this is what a terminal shows: a `pnpm dev` left
 * running for an hour writes megabytes and the interesting line is the last
 * one. 256KB is comfortably more than a panel can render and small enough that
 * a poll while the command runs stays cheap.
 */
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;

/** What one background command has written so far. */
export const ShellOutputWireSchema = z.object({
  text: z.string().describe('the tail of the output file, decoded as UTF-8'),
  truncated: z
    .boolean()
    .describe('earlier output was dropped — this is the tail of a longer file'),
  /**
   * Why there is nothing to show, or null when {@link text} is the answer.
   *
   * A 200 rather than a 404, on the same rule the metrics route follows: "this
   * command was not detached, so the CLI kept no output file" is an ANSWER the
   * panel states, not a failure. Only a malformed request — an unknown run, a
   * call id the run never made — is a 4xx.
   */
  unavailableReason: z.string().nullable(),
});
// No `.meta({ id })`: this is a response DTO ROOT — same rule, and same reason,
// as `LocalImageWireSchema` above.
export type ShellOutputWire = z.infer<typeof ShellOutputWireSchema>;

/**
 * One line item of the context window — a NAMED component, so the generated
 * client gets a real type rather than an inline anonymous shape per field.
 */
const ContextCategorySchema = z
  .object({
    name: z.string().describe("the CLI's own name for this part of the window"),
    tokens: z.number(),
    deferred: z
      .boolean()
      .describe(
        'available but not loaded, and so NOT counted in totalTokens — rendering it in the same bar reports a window several times fuller than it is',
      ),
  })
  .meta({ id: 'ContextCategory' });

const ContextMemoryFileSchema = z
  .object({
    path: z.string(),
    kind: z
      .string()
      .nullable()
      .describe(
        "the CLI's own word for where it came from (Project, AutoMem…)",
      ),
    tokens: z.number(),
  })
  .meta({ id: 'ContextMemoryFile' });

const ContextServerSchema = z
  .object({
    name: z.string(),
    tokens: z.number().describe("this server's whole tool surface, summed"),
    toolCount: z.number(),
    loadedToolCount: z
      .number()
      .describe('how many of them are actually in the window right now'),
  })
  .meta({ id: 'ContextServer' });

/** The context window's contents, as the agent's own CLI accounts for them. */
export const ContextBreakdownWireSchema = z
  .object({
    categories: z.array(ContextCategorySchema),
    totalTokens: z.number().nullable(),
    maxTokens: z.number().nullable(),
    model: z.string().nullable(),
    autoCompactAtTokens: z
      .number()
      .nullable()
      .describe('where this CLI would compact the conversation by itself'),
    autoCompactEnabled: z.boolean().nullable(),
    memoryFiles: z.array(ContextMemoryFileSchema),
    servers: z.array(ContextServerSchema),
  })
  .meta({ id: 'ContextBreakdown' });
export type ContextBreakdownWire = z.infer<typeof ContextBreakdownWireSchema>;

/**
 * One rate-limit window of the plan behind this chat's account — a NAMED
 * component, so the generated client gets a real type.
 */
const PlanWindowSchema = z
  .object({
    key: z
      .string()
      .describe("the CLI's own key for the window — opaque, for keying rows"),
    label: z.string().describe('what to call it on screen'),
    percent: z.number().describe('how much of the window is used, 0-100'),
    resetsAt: z
      .string()
      .nullable()
      .describe('ISO 8601 moment it refills, or null when the CLI named none'),
  })
  .meta({ id: 'PlanWindow' });

/**
 * What the account behind this chat is allowed, as its CLI reports it.
 *
 * On the CHAT route rather than a global one because a run carries its own
 * `configDir`: two threads open side by side can be signed in to different
 * accounts on different plans, and one figure in an app header would be
 * describing whichever of them was asked last.
 */
export const PlanLimitsWireSchema = z
  .object({
    plan: z
      .string()
      .nullable()
      .describe("the subscription in the CLI's own word ('pro', 'max', …)"),
    windows: z.array(PlanWindowSchema),
  })
  .meta({ id: 'PlanLimits' });
export type PlanLimitsWire = z.infer<typeof PlanLimitsWireSchema>;

/**
 * The last reading taken from a run's own agent, as it is stored on the run row
 * (`Run.lastMetricsReading`) — never on the wire.
 *
 * Parsed back through the SAME schemas the route answers with, so a reading
 * whose shape has since moved is discarded rather than served as figures the
 * renderer cannot draw. `atSeq` is the transcript position it describes: a run
 * whose items have grown since has had turns this reading knows nothing about,
 * and stale figures under a timestamp are still stale figures.
 */
export const StoredMetricsReadingSchema = z.object({
  takenAt: z.string(),
  atSeq: z.number(),
  /**
   * The agent config directory — the ACCOUNT — this reading was taken under,
   * null for the CLI's own default profile.
   *
   * `atSeq` says the reading still describes this CONVERSATION; this says it
   * still describes the account whose allowance it reports. The two are
   * independent, and a chat can change account without saying a word: switching
   * a live chat's profile carries its conversation across, so the transcript
   * position is untouched while every account-level figure in the reading now
   * belongs to somebody else.
   *
   * REPORTED as a panel reading `TEAM · Current week 100%` on a chat whose
   * chip said `.claude-manifest-lab-personal`. Both profiles were on disk:
   * `.claude-manifest-lab` is `claude_team`, `-personal` is `claude_max`, and
   * the run row's own `config_dir` was the personal one — so the figures were
   * the team account's, kept across the switch.
   *
   * Required rather than optional, so a reading filed before this field
   * existed fails the parse and is simply taken again. There is nothing to
   * migrate: the whole value is a cache of one question.
   */
  configDir: z.string().nullable(),
  context: ContextBreakdownWireSchema.nullable(),
  plan: PlanLimitsWireSchema.nullable(),
});
export type StoredMetricsReading = z.infer<typeof StoredMetricsReadingSchema>;

/**
 * What the whole thread has spent, summed over its finished turns.
 *
 * Summed on the DAEMON rather than in the renderer, though the renderer holds
 * the same items: a chat's history is paged behind an `afterSeq` cursor, so a
 * client that has only scrolled back through part of it would total part of
 * it — and silently, since a smaller number looks exactly like a cheaper
 * conversation.
 */
export const ChatTotalsWireSchema = z
  .object({
    turns: z.number().describe('turns that reported usage'),
    costedTurns: z
      .number()
      .describe(
        'of those, how many reported a COST — the denominator for an average spend, since a turn on a CLI that reports no cost would otherwise dilute it',
      ),
    costUsd: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    cacheCreationTokens: z.number().nullable(),
    thinkingTokens: z.number().nullable(),
    workedMs: z
      .number()
      .nullable()
      .describe("the CLI's own working time, where it reported one"),
  })
  .meta({ id: 'ChatTotals' });
export type ChatTotalsWire = z.infer<typeof ChatTotalsWireSchema>;

/**
 * The totals ALONE, for a caller that wants the spend and not the window.
 *
 * A route of its own because the two halves cost wildly different things.
 * `ChatMetricsWireSchema` answers both at once so the panel can never show a
 * breakdown from one moment beside a spend from another — but the breakdown is
 * a round trip to the live CLI (measured at 1.2–3.3s), which is why that route
 * is fetched only when the readout is opened. The chat HEADER wants the spend
 * on every thread it opens, and paying a CLI dial for a figure that comes
 * straight out of the database would put that latency on simply switching
 * chats.
 *
 * WRAPPED in an object rather than answering `ChatTotals` at the root:
 * {@link ChatTotalsWireSchema} carries `.meta({ id })`, and nestjs-zod would
 * register the component under that id while the response still pointed at the
 * DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
 */
export const ChatTotalsResponseSchema = z.object({
  totals: ChatTotalsWireSchema,
});
export type ChatTotalsResponse = z.infer<typeof ChatTotalsResponseSchema>;

/**
 * What one chat's context window holds right now, plus what the whole thread
 * has cost — the readout behind the composer's context ring.
 *
 * Two halves with two different sources, deliberately answered by ONE route so
 * the panel cannot show a breakdown from one moment beside a spend from
 * another. The breakdown is ASKED of the live CLI process, so it exists only
 * while the run holds one; the totals are summed from the thread's own
 * persisted turns and are always there.
 */
export const ChatMetricsWireSchema = z.object({
  context: ContextBreakdownWireSchema.nullable(),
  breakdownReason: z
    .string()
    .nullable()
    .describe(
      'why there is no breakdown — a CLI without the channel, or a chat with no running agent to ask',
    ),
  plan: PlanLimitsWireSchema.nullable(),
  planReason: z
    .string()
    .nullable()
    .describe(
      'why there are no plan limits — its own field beside breakdownReason because the two are separate channels and a CLI can answer one without the other',
    ),
  takenAt: z
    .string()
    .nullable()
    .describe(
      'when the two readings above were taken, when they are the LAST reading of an agent whose process has since been closed — null when they are live, or absent',
    ),
  totals: ChatTotalsWireSchema,
});
// No `.meta({ id })` on this one: it is a RESPONSE DTO ROOT, and nestjs-zod
// would then register the component under the id while the route still points
// at the DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
// The nested shapes above carry ids precisely because they are not roots.
export type ChatMetricsWire = z.infer<typeof ChatMetricsWireSchema>;

/**
 * One image attached to a user message. Only the METADATA lives in the item
 * payload (and therefore SQLite) — the bytes are a file under
 * `<userData>/attachments/<runId>/`, per the storage split: SQLite holds
 * runtime/history, not blobs. `id` is the file's basename, so the row is all
 * the attachment route needs to find the bytes again.
 */
export const AttachmentWireSchema = z
  .object({
    id: z.string(),
    mediaType: AttachmentMediaTypeSchema,
  })
  .meta({ id: 'AttachmentWire' });
export type AttachmentWire = z.infer<typeof AttachmentWireSchema>;

/** One image as it arrives on the send-message body: bytes, not yet stored. */
export interface SendMessageImage {
  mediaType: AttachmentMediaType;
  /** base64-encoded bytes. */
  data: string;
}

/** A stored attachment read back for display (base64 — see AttachmentDataDto). */
export interface AttachmentDataWire extends SendMessageImage {
  id: string;
}

/**
 * A persisted transcript item projected to the wire — `payload` is parsed back
 * from its stored JSON string so the renderer receives structured data, not a
 * doubly-encoded string. This is the shape the daemon emits over `/ws` and the
 * REST history read; the UI mirrors it in `shared/contracts.ts`.
 */
export const ItemWireSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string().nullable().describe('Graph node id; null for a chat'),
  seq: z
    .number()
    .int()
    .describe('Monotonic per-run sequence — the replay cursor'),
  kind: ItemKindSchema,
  role: z.string().nullable(),
  payload: z.unknown().describe('Kind-specific structured payload'),
  createdAt: z.string(),
});
export type ItemWire = z.infer<typeof ItemWireSchema>;

/**
 * The version of the export DOCUMENT's own shape, stamped on every file.
 *
 * An export is read back by whatever the user pastes it into — a bug report, a
 * script, a later build of this app — long after the daemon that wrote it is
 * gone, so the reader needs to know which shape it is holding. Bumped when a
 * field is removed or changes meaning; adding one does not, since a reader that
 * does not know a key ignores it.
 */
export const CHAT_EXPORT_FORMAT_VERSION = 1;

/**
 * The run's own row in an export — every column, including the four the wire
 * has never carried.
 *
 * Deliberately NOT {@link RunWireSchema}: that shape is what a CHAT SCREEN
 * needs, so it folds in live registry readings (`awaiting`, `holdingFor`) that
 * describe this instant rather than the conversation, and it withholds the
 * fields nothing renders — `customInstructions`, `cursorMaxMode`,
 * `lastMetricsReading`, `pendingContext`. Those four are exactly what a
 * debugging export is for: they are what the turns actually ran under, and
 * three of them can silently change what a CLI did.
 */
export const ChatExportRunSchema = z
  .object({
    id: z.string(),
    workflowId: z.string().nullable(),
    status: RunStatusSchema,
    title: z.string().nullable(),
    agentKind: AgentKindSchema.nullable(),
    cwd: z.string().nullable(),
    model: z.string().nullable(),
    approval: ChatApprovalModeSchema.nullable(),
    effort: z.string().nullable(),
    contextWindow: z.string().nullable(),
    modelParameters: z.record(z.string(), z.string()),
    contextTokens: z.number().nullable(),
    contextWindowTokens: z.number().nullable(),
    configDir: z.string().nullable(),
    groupId: z.string().nullable(),
    customInstructions: z
      .string()
      .nullable()
      .describe(
        "The user's standing instructions AS THIS RUN SNAPSHOTTED THEM — not what the settings box says now",
      ),
    cursorMaxMode: z
      .boolean()
      .nullable()
      .describe(
        'Whether this run asks cursor for Max Mode; null = the run predates the setting, which the adapter reads as the default rather than as off',
      ),
    lastMetricsReading: z
      .unknown()
      .describe(
        "The last context/plan reading taken from this run's agent before its process closed, as stored; null when none was ever kept",
      ),
    pendingContext: z
      .string()
      .nullable()
      .describe(
        'A compaction summary owed to the next turn; non-null only between a geniro-performed compaction and the message that consumes it',
      ),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'ChatExportRun' });
export type ChatExportRunWire = z.infer<typeof ChatExportRunSchema>;

/**
 * One `node_state` row in an export — empty for a chat, one entry per node for
 * a workflow run.
 *
 * Included because it holds what the transcript cannot say: which CLI and which
 * model each node ACTUALLY ran as (stamped at turn start, so run history does
 * not depend on the live YAML), the session id that turn resumed by, and the
 * error that ended it.
 */
export const ChatExportNodeSchema = z
  .object({
    nodeId: z.string(),
    status: z.string(),
    agentKind: AgentKindSchema.nullable(),
    model: z.string().nullable(),
    agentSessionId: z.string().nullable(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'ChatExportNode' });
export type ChatExportNodeWire = z.infer<typeof ChatExportNodeSchema>;

/**
 * One whole conversation as a file — the thread's settings, its complete
 * transcript with every tool call and result verbatim, its per-node execution
 * state and what it cost.
 *
 * Assembled by the DAEMON rather than from what a client holds, and that is the
 * point rather than a convenience: a chat's history is paged behind an
 * `afterSeq` cursor, so the renderer only ever holds the window it has scrolled
 * through — an export built there would silently be a fraction of a long
 * conversation, which is the exact failure `ChatTotalsWireSchema` records for
 * the totals beside it.
 *
 * `items` inlines {@link ItemWireSchema} rather than referencing it as a named
 * component: that schema is `ItemDto`'s ROOT, so giving it `.meta({ id })` is
 * the dangling `$ref` `setupSwagger` fails the boot on.
 *
 * No `.meta({ id })` on this one either — it is a response DTO root.
 */
export const ChatExportWireSchema = z.object({
  formatVersion: z
    .number()
    .int()
    .describe('Shape of this document — see CHAT_EXPORT_FORMAT_VERSION'),
  exportedAt: z.string(),
  daemonVersion: z
    .string()
    .describe('The daemon build that wrote this file, for a bug report'),
  run: ChatExportRunSchema,
  totals: ChatTotalsWireSchema,
  nodes: z.array(ChatExportNodeSchema),
  items: z
    .array(ItemWireSchema)
    .describe(
      'The COMPLETE transcript in seq order — payloads parsed back from their stored JSON, so a tool_call and its tool_result survive verbatim',
    ),
});
export type ChatExportWire = z.infer<typeof ChatExportWireSchema>;

/**
 * One skill / slash command a CLI agent can be invoked with (`/name …` in the
 * message) in a given working directory — the rows of the composer's `/`
 * autocomplete. `kind` separates a skill directory
 * (`.claude/skills/<dir>/SKILL.md`) from a command file
 * (`.claude/commands/**.md`, `.cursor/commands/*.md`); `source` says where it
 * was discovered — the project folder, the user's home dir, or `cli`: the
 * claude session's own `system/init` report harvested on a prior turn in this
 * cwd (built-ins + plugin skills the disk scan can't see; always
 * `kind: 'command'`, no description), or `geniro`: a command this APPLICATION
 * adds to that CLI, which exists nowhere outside it — see
 * `AgentGeniroCommand`. The UI mirrors this in `shared/contracts.ts`.
 */
export const AgentSkillWireSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  kind: z
    .enum(['skill', 'command'])
    .describe('A skill directory (SKILL.md) vs a plain command file'),
  // `geniro` leads the list deliberately: these names are RESERVED — the chat
  // service dispatches them by name whatever else is on disk — so the popup
  // has to show the row that will actually run.
  source: z
    .enum(['geniro', 'project', 'user', 'cli'])
    .describe(
      'Where it came from — this app itself, a disk scan, or the CLI session',
    ),
});
export type AgentSkillWire = z.infer<typeof AgentSkillWireSchema>;

/**
 * One model a CLI accepts for `--model`.
 *
 * `source` says where the row came from, because the two CLIs can answer very
 * differently: `cli` means the CLI itself reported it (cursor's `models`
 * subcommand, or the account models claude caches for its own picker), `builtin`
 * means the documented alias set we fall back to when the CLI cannot be asked —
 * an install too old for the subcommand, or one that is not signed in.
 */
// No `.meta({ id })` on this root: it backs an ARRAY response DTO, and an id
// there leaves the array pointing at a component that is never emitted (the
// boot guard in setupSwagger fails on exactly that dangling $ref).
export const AgentModelWireSchema = z.object({
  id: z.string().describe('Passed verbatim to the CLI as `--model <id>`'),
  label: z.string(),
  source: z
    .enum(['cli', 'builtin'])
    .describe('Reported by the CLI, or our documented fallback set'),
});
export type AgentModelWire = z.infer<typeof AgentModelWireSchema>;

/**
 * One MCP server a CLI agent loads in a working directory, with the health the
 * CLI itself reported for it.
 *
 * The set is per-CLI AND per-folder — a CLI resolves project-scoped servers
 * relative to where it runs — which is why the read is keyed on both and why
 * two agents in one thread legitimately show different lists.
 *
 * `status` carries `unknown` on purpose: for a CLI whose only listing is
 * human-readable prose, a reworded release must cost a health badge, never the
 * server row. `detail` is whatever the CLI printed after the status — the
 * failure reason, or what an unapproved server is waiting for — and is the
 * only actionable part of a failure.
 *
 * `target` and `transport` are nullable because not every CLI reports them:
 * claude prints the server's command line, cursor prints only a name and a
 * status. Null says "this CLI did not tell us", which an empty string could
 * not — it would have claimed a command exists and silently blanked the row's
 * tooltip instead.
 */
export const AgentMcpServerWireSchema = z
  .object({
    name: z.string(),
    target: z
      .string()
      .nullable()
      .describe(
        'The command line or URL the CLI reaches the server through, or null when the CLI does not report one',
      ),
    transport: z
      .enum(['stdio', 'http', 'sse'])
      .nullable()
      .describe('Null when the CLI does not report one'),
    status: z
      .enum([
        'connected',
        'failed',
        'pending',
        'loading',
        'disabled',
        'needs_auth',
        'unknown',
      ])
      .describe(
        'Health as the CLI reported it; `pending` is a configured but unapproved server, `loading` one the CLI was still dialling when it answered, `disabled` one switched off in the CLI’s own config, `needs_auth` an OAuth server nobody has signed in to yet',
      ),
    detail: z
      .string()
      .nullable()
      .describe('The failure reason, or what the server is waiting for'),
    scope: z
      .enum(['user', 'workspace', 'unknown'])
      .describe(
        'Which of the CLI’s configuration scopes defined this server; `unknown` when the CLI’s files could not place it',
      ),
    shadowsUser: z
      .boolean()
      .describe(
        'True when this WORKSPACE definition overrides a same-named user one, so the user’s own server is not what this folder loads under that name',
      ),
    disabled: z
      .boolean()
      .describe(
        'Whether the next turn will leave this server out, whoever switched it off',
      ),
    toggleUnavailableReason: z
      .string()
      .nullable()
      .describe(
        'Why this row carries no switch, or null when it does. A sentence, so the UI never has to derive one from `scope`',
      ),
    signInUnavailableReason: z
      .string()
      .nullable()
      .describe(
        'Why this row offers no sign-in, or null when it does. Answered for EVERY row, not just `needs_auth` ones, so the UI never infers a capability from a status',
      ),
    approveUnavailableReason: z
      .string()
      .nullable()
      .describe(
        'Why this row offers no approve, or null when it does. Answered for EVERY row on the same rule as `signInUnavailableReason`, so a `pending` row never gets a control the CLI has nothing behind',
      ),
  })
  .meta({ id: 'AgentMcpServer' });
export type AgentMcpServerWire = z.infer<typeof AgentMcpServerWireSchema>;

/**
 * One agent's MCP listing for one folder.
 *
 * An OBJECT rather than a bare array because an empty list is ambiguous on its
 * own, and resolving that ambiguity must not become a "which CLI is this?"
 * branch in the reader.
 *
 * `servers: []` with a NULL reason is the only shape that asserts anything
 * about the user's configuration — it means the folder genuinely has none.
 * A non-null reason means we are not asserting that, and it covers BOTH a CLI
 * that cannot be asked at all (`AdapterConfig.mcp.listingUnavailableReason`)
 * and a read that failed or could not be understood. The UI shows the sentence
 * verbatim rather than composing one, and today treats the two identically.
 *
 * A consumer that must tell a PERMANENT refusal from a TRANSIENT one — a
 * Retry affordance, or milestone 4 deciding whether cursor has gained a
 * listing — needs a discriminator added here rather than a match on the prose.
 * Deliberately not added yet: nothing reads it, and inventing the field now
 * would be a wire commitment with no consumer to shape it.
 *
 * `pending` is the THIRD shape, and the reason it had to exist: a cold read
 * dials every server the folder defines, which is measured in seconds and
 * bounded only by the slowest one. Blocking the response on that made the panel
 * hold an HTTP request open for up to the CLI's whole listing timeout. So a
 * cold read now answers immediately with `pending: true`, and the dial
 * continues behind it — meaning `servers: []` asserts "this folder has none"
 * only when `pending` is false. A consumer that ignores the flag would read a
 * read-in-progress as an empty folder.
 *
 * A pending answer MAY carry rows, and they are the folder's PREVIOUS reading
 * (`AgentMcpService.firstPaint`). It could not, until a user reported the panel
 * "loading for a minute" — the rows were being withheld for the whole of a
 * re-dial that already knew what the folder held, so the one moment the list
 * was most wanted was the one moment it showed nothing. `pending` still means
 * exactly what it meant: these rows are not the answer YET. What changed is
 * that a stale row beats an empty panel, which the flag is what makes safe to
 * say.
 */
// No `.meta({ id })` on this ROOT: it is the response DTO's own schema (see
// AgentModelWireSchema above for the dangling-$ref an id here would cause).
export const AgentMcpListingWireSchema = z
  .object({
    servers: z.array(AgentMcpServerWireSchema),
    unavailableReason: z
      .string()
      .nullable()
      .describe('Why this CLI cannot be listed at all; null when it can'),
    pending: z
      .boolean()
      .describe(
        'A cold read is running; these rows are not the answer yet. Ask again.',
      ),
    interactiveOnlyNote: z
      .string()
      .nullable()
      .describe(
        "What this CLI loads only in its OWN interactive session, so the panel's completeness is not mistaken for lost rows; null when there is no such gap",
      ),
  })
  // Three fields, but only three LEGAL states — reading, refused, answered. The
  // combination below is representable and means nothing, and every consumer
  // was guarding against it by hand (each construction site spells
  // `pending: false`). One missed guard renders a read-in-progress as "No
  // servers", a claim about the user's configuration that nobody made.
  //
  // ROWS are no longer part of this rule (see the doc block): a pending answer
  // carries the folder's previous reading, so the panel keeps its list through
  // a re-dial. A REASON still is — "we cannot ask this CLI at all" and "we are
  // still asking" are opposite claims, and an envelope asserting both leaves
  // the renderer to pick.
  //
  // Enforced on the RESPONSE, which is where it bites: `@ZodResponse`
  // serializes through this schema, so a daemon that ever composed an illegal
  // envelope fails here rather than shipping it to a renderer that has to
  // re-derive which field wins.
  .refine(
    (listing) => !listing.pending || listing.unavailableReason === null,
    'a pending listing states no reason — it is the answer not being ready yet',
  );
export type AgentMcpListingWire = z.infer<typeof AgentMcpListingWireSchema>;

/**
 * One reasoning-effort level a CLI accepts for `--effort`.
 *
 * Opaque strings, never an enum on the wire: the vocabulary belongs to one
 * CLI (`AgentAdapter.listEfforts`), and pinning claude's six values into the
 * shared contract would put a CLI fact outside the adapter layer — and hand
 * the renderer a list it must never carry. An EMPTY array is the meaningful
 * answer for a CLI with no effort control; the composer omits the chip.
 */
export const AgentEffortWireSchema = z
  .object({
    id: z.string().describe('Passed verbatim to the CLI as `--effort <id>`'),
    label: z.string(),
  })
  .meta({ id: 'AgentEffort' });
export type AgentEffortWire = z.infer<typeof AgentEffortWireSchema>;

/**
 * The effort levels available for ONE model, and why there are none.
 *
 * An object rather than the bare array this used to be, because the levels are
 * a property of the MODEL and not only of the CLI — measured on cursor-agent
 * 2026.08.11-e8db854: `claude-opus-5` offers `low|medium|high|xhigh|max`,
 * `grok-4.6` the same minus `max`, and `auto-smart` / `composer-2.5` no effort
 * axis at all. An array alone could say "none" but never WHY, and a picker that
 * silently vanishes for some models is the complaint this whole control already
 * has a scar from ("I cannot change the effort of a Cursor model").
 *
 * `unavailableReason` therefore has two producers and they mean different
 * things: the CLI has no effort control at all (`AdapterConfig`), or this
 * particular model does not. Both are sentences the chip shows on hover; the
 * consumer does not care which.
 */
export const AgentEffortListingWireSchema = z.object({
  efforts: z.array(AgentEffortWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why there are no levels; null when there are.'),
});
// No `.meta({ id })` on this one: it is a RESPONSE DTO ROOT, and nestjs-zod
// would then register the component under the id while the route still points
// at the DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
// The component name a client sees is the DTO class name, which is what every
// sibling listing here emits.
/**
 * One context-window size a model can be run at.
 *
 * Opaque strings for the same reason the effort vocabulary is (`300k`, `1m`,
 * `272k` are cursor's own words) — and deliberately NOT a token count. The
 * number a user cares about is the one the agent then reports about its own
 * window, which the meter already draws; a count here would be a second answer
 * to that question with nothing keeping the two in step.
 */
export const AgentContextWindowWireSchema = z
  .object({
    id: z
      .string()
      .describe("Passed verbatim to the CLI as that model's window setting"),
    label: z.string(),
  })
  .meta({ id: 'AgentContextWindow' });
export type AgentContextWindowWire = z.infer<
  typeof AgentContextWindowWireSchema
>;

/**
 * The window sizes available for ONE model, and why there are none.
 *
 * The twin of {@link AgentEffortListingWireSchema}, per model for the same
 * measured reason — swept 2026-08-21 across a cursor account's 34 models,
 * twelve offer the axis and their vocabularies differ (`300k|1m`, `272k|1m`,
 * `200k|1m`).
 *
 * `unavailableReason` has four producers here and they mean different things:
 * no model has been chosen yet, this CLI has no such control at all, this
 * MODEL runs at one fixed window, or the CLI could not be asked. All four are
 * sentences the chip shows on hover.
 *
 * `unavailableKind` says WHICH of them it is, and exists because the consumer
 * DOES care about one: with no model chosen there is nothing to list yet, and
 * a chip labelled "one window" there states a fact about a model nobody has
 * picked. Every other kind really does mean one fixed window. Without this
 * field the renderer had to match the sentence itself, so rewording the prose
 * on this side silently reverted the label on the other.
 */
export const AgentContextWindowUnavailableKindSchema = z
  .enum(['no-model', 'no-axis', 'fixed-window', 'unreadable'])
  .meta({ id: 'AgentContextWindowUnavailableKind' });

export const AgentContextWindowListingWireSchema = z.object({
  windows: z.array(AgentContextWindowWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why there are no sizes to choose from; null when there are.'),
  unavailableKind: AgentContextWindowUnavailableKindSchema.nullable().describe(
    'Which kind of unavailability the reason describes; null when sizes are offered.',
  ),
});
// No `.meta({ id })` — a RESPONSE DTO ROOT, see the sibling above.
export type AgentContextWindowListingWire = z.infer<
  typeof AgentContextWindowListingWireSchema
>;

export type AgentEffortListingWire = z.infer<
  typeof AgentEffortListingWireSchema
>;

/** One accepted value of an {@link AgentModelParameterWireSchema}. */
export const AgentModelParameterValueWireSchema = z
  .object({
    id: z
      .string()
      .describe('Passed verbatim to the CLI as this parameter’s value'),
    label: z.string(),
  })
  .meta({ id: 'AgentModelParameterValue' });

/**
 * One setting of a model that geniro has no dedicated control for, exactly as
 * the CLI enumerated it — see `AgentModelParameter` in `adapter.types.ts` for
 * the measurements behind it and why it is a pass-through rather than a
 * vocabulary this app knows.
 *
 * `label` is the CLI's own display name, never a prettified id: `Optimize For`
 * is what cursor calls `optimize_for`, and inventing that string on either side
 * of the wire would be geniro naming another product's setting.
 */
export const AgentModelParameterWireSchema = z
  .object({
    id: z.string().describe('The CLI’s own parameter id, sent back verbatim'),
    label: z.string(),
    values: z.array(AgentModelParameterValueWireSchema),
    current: z
      .string()
      .nullable()
      .describe(
        'The value the CLI reports the model is on; null when it named none.',
      ),
  })
  .meta({ id: 'AgentModelParameter' });
export type AgentModelParameterWire = z.infer<
  typeof AgentModelParameterWireSchema
>;

/**
 * Every such parameter of ONE model.
 *
 * Per model like the context listing and for the same reason, only more so:
 * measured 2026-08-26, `optimize_for` exists on exactly one of a cursor
 * account's thirty-four models. There is no union worth serving.
 */
export const AgentModelParameterListingWireSchema = z.object({
  parameters: z.array(AgentModelParameterWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why there are none; null when there are some.'),
});
// No `.meta({ id })` — a RESPONSE DTO ROOT, see the sibling above.
export type AgentModelParameterListingWire = z.infer<
  typeof AgentModelParameterListingWireSchema
>;

/**
 * What a manual cache reset threw away.
 *
 * A COUNT rather than an ok/failed, because the reset cannot fail — every clear
 * behind it is a `Map.clear()` and a file write nobody waits on — while "how
 * much was there" is the one thing the presser cannot know and the only honest
 * confirmation the row can give.
 */
export const AgentCacheResetWireSchema = z.object({
  cleared: z
    .number()
    .int()
    .describe('How many cached CLI answers were dropped.'),
});
// No `.meta({ id })` — a RESPONSE DTO ROOT, see the sibling above.
export type AgentCacheResetWire = z.infer<typeof AgentCacheResetWireSchema>;

/**
 * Payload of an `unanswerable` item: one approval request whose turn settled
 * while it was still pending, so no verdict can ever reach it.
 *
 * `id` is the SAME request id the `approval_request` payload carries, which is
 * what lets the renderer close exactly that card.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/transcript-item.tsx` reads this
 * shape out of the item's `payload`. Item payloads are `z.unknown()` on the
 * wire BY DESIGN (each kind carries a different shape), so no generated type
 * spans the two sides — a change here MUST be mirrored there.
 */
export interface UnanswerableWire {
  id: string;
  toolName: string;
}

/** One persisted item, ready to fan out to its run's WS room (persist-then-emit). */
export interface RunItemEvent {
  runId: string;
  item: ItemWire;
}

/**
 * A run's status changed, broadcast to every client rather than to one room.
 *
 * TWIN PARSER: `apps/ui/src/renderer/daemon-client.ts` reads this shape off the
 * `run_status` Socket.IO event. Outside the generated HTTP contract (no route
 * carries it), so the two sides are independent implementations and a shape
 * change here MUST be mirrored there.
 *
 * `activity` is a short plain-English phrase naming what the run is doing
 * right now ("running Bash", "waiting for you"), or null when it is not doing
 * anything — a badge that says only "running" cannot distinguish an agent
 * working from one parked on a question nobody answered.
 */
export interface RunStatusEvent {
  runId: string;
  /**
   * Whether this run is parked on the USER, and on what — or `undefined` when
   * this event says nothing about it.
   *
   * Three states, deliberately: `undefined` (absent on the wire) asserts
   * nothing and leaves the client's reading alone, `null` says the run is no
   * longer parked, and a kind says it is. The same distinction `status` below
   * draws, for the same reason — only the two transitions (a card opening, a
   * card closing) know anything about this, and every other announce must not
   * overwrite what they said.
   *
   * It exists because "parked on you" was knowable ONLY for the chat in focus:
   * the renderer derived it from that run's transcript items, which are the one
   * thing a background run does not stream. So a run waiting on an answer went
   * on showing a spinner in the sidebar for as long as the user was looking
   * somewhere else — the one state where a spinner is actively misleading,
   * since nothing will move until they come back.
   */
  awaiting?: RunAwaiting | null;
  /**
   * How many units of background work this run's turn is being HELD for, or
   * `undefined` when this event says nothing about it.
   *
   * A held turn is one whose AGENT has finished and whose process geniro is
   * keeping alive only until the delegates it launched report back — see
   * `AgentEvent`'s `turn_held`. `0` says the hold is over; a count says it is
   * on, and the composer reads it to decide whether a message goes straight to
   * the CLI or into the queue. It is a FACT rather than something to infer from
   * `activity`, which is prose and is free to be reworded.
   *
   * Three states like {@link awaiting}, and for the same reason: only the two
   * transitions know anything about it, and every other announce must leave the
   * client's reading alone.
   */
  holdingFor?: number;
  /**
   * How many DETACHED commands this run still has out, or `undefined` when this
   * event says nothing about it.
   *
   * Three states like {@link holdingFor} beside it, and for the identical
   * reason: only the open and the close know anything about the count, and
   * every other announce must leave the client's reading alone. `0` says the
   * last one has reported.
   *
   * Unlike {@link holdingFor} this is a DISPLAY fact and nothing acts on it —
   * a shell does not hold a turn open, so the composer must not read it to
   * decide whether a message queues. It exists so a row can say "the agent has
   * finished and something it started is still running" whether or not the user
   * happens to have that thread open.
   */
  shellsOpen?: number;
  /**
   * The run's new status, or null when this event only says what the run is
   * DOING and asserts nothing about whether it is still going.
   *
   * The distinction is load-bearing. The activity announce fires from inside a
   * turn's event stream — on every tool call — and it never reads the run's
   * status, so while it published a hardcoded `'running'` the client wrote that
   * back onto the row: one straggler event arriving after a cancel or a
   * terminal write flipped the run to "running", and nothing announced again to
   * correct it. A status this event never read is not one it may assert, so it
   * sends null and the client leaves the badge alone.
   */
  status: RunStatus | null;
  /**
   * What the run is doing right now, `null` when it is doing nothing — or
   * ABSENT when this announce says nothing about it.
   *
   * Three states, like {@link awaiting} and {@link holdingFor} beside it. The
   * field was two, and every producer genuinely read the run, so `null` could
   * safely mean "nothing is happening". A producer that does NOT read it has no
   * honest value to send: `null` is what CLEARS the client's phrase, so a
   * naming announce would blank the badge and the transcript's live row of a
   * turn that is running.
   */
  activity?: string | null;
  /**
   * When the run ROW was written — present on exactly the announces that wrote
   * it, absent on every activity-only one.
   *
   * It is the sidebar's ORDER, and it exists because that order was the one
   * thing a background run could not keep honest. `updatedAt` rides the run
   * row, and a client only re-reads rows on a refetch, so a thread that was
   * working somewhere else kept the time it was loaded with for the whole
   * session and sat wherever that put it. The renderer then learned the truth
   * at the moment the user OPENED it, which is the reported "as soon as I click
   * a thread it jumps to the top" — the jump was the list catching up, and the
   * click was the only thing that could trigger it.
   *
   * Three states, like {@link awaiting} and {@link holdingFor}: absent asserts
   * nothing. That is what keeps it truthful rather than merely live — an
   * activity announce fires on every tool call and does NOT touch the row, so
   * stamping one would put the client ahead of the database and a later refetch
   * would drag the thread back down the list. This carries the row's own write
   * moment (to within the flush that produced it), so the two agree.
   */
  at?: string;
  /**
   * What the run has to SAY about a status it just reached — the agent's
   * closing words, or a failure's own message.
   *
   * It exists for the client that is NOT looking at this chat: a system
   * notification has to be able to say what happened, and the only other source
   * — the run row's `lastMessage` — is enriched by list endpoints alone, so for
   * a background thread it still holds the USER's message from before the turn.
   * A banner reading back what you typed is worse than no banner.
   *
   * THREE states, like {@link awaiting} and {@link holdingFor} and for the same
   * reason: `undefined` (absent on the wire) asserts nothing, so an activity
   * announce leaves the client's reading alone, while `null` says this settle
   * had nothing to say and CLEARS it. Conflating the two is what made a
   * wordless turn announce the PREVIOUS one's closing words — the client keeps
   * the last sentence it was given, so a `/compact` turn, which produces no
   * assistant message at all, notified with the answer from before the
   * compaction. Every terminal write therefore carries the field; every
   * non-terminal one omits it (`writeRunStatus` is the one place that decides).
   *
   * Untrimmed and unbounded here on purpose: what fits in a banner is the
   * presenting side's decision, and truncating twice would leave the transcript
   * and the notification disagreeing about the same sentence.
   */
  summary?: string | null;
  /**
   * The text of a `message` item this run just persisted — the sidebar's
   * preview line, pushed as it happens.
   *
   * A SEPARATE field from {@link summary}, which is deliberately terminal-only:
   * that one is what a settle has to SAY, it feeds the system notification, and
   * `writeRunStatus` is the one place allowed to decide it — sending it
   * mid-turn would put a half-finished turn's words where a banner reads the
   * closing ones. This asserts nothing about status and is never notified on.
   *
   * REPORTED as "still i see here outdated last llm message. As soon as i click
   * on thread - it will be updated to actual one", against a RUNNING thread —
   * which is the boundary the settle-time fix left standing: the preview moved
   * when a turn ended, so a turn working for twenty minutes showed the sentence
   * it started from, and opening the chat was the only thing that corrected it.
   *
   * Both ROLES ride it, because `lastMessage` is the run's latest `message` row
   * whatever wrote it — announcing only the agent's would make the line
   * disagree with the value the next list refetch puts back.
   *
   * Two states, not three: absent asserts nothing, and there is no clearing
   * arm. A message cannot be unsaid, and the row's own `lastMessage` is only
   * ever replaced by a later one.
   */
  preview?: string;
  /**
   * True when the turn that reached this status produced NOTHING but the CLI's
   * own context compaction — absent on every other announce, settle or not.
   *
   * Housekeeping is the word the compaction event already uses for itself, and
   * it is the whole point: `/compact` is an ordinary turn on the wire (the
   * user's command, the CLI's summary row, a terminal item), so it settled the
   * run like any other and earned a banner and a sidebar mark. Reported as
   * "when I do a compact, a notification gets sent to me … don't need a
   * notification when the compact fires".
   *
   * Said by the DAEMON rather than derived by the client, because the client
   * that has to act on it is the one NOT looking: a background chat's items are
   * never loaded, so the renderer's own structural reader (`compactionOnlyTurnEnds`,
   * which hides the redundant `✓ done` in the transcript) can only answer for
   * the chat on screen — the one case where no banner fires anyway.
   *
   * Structural, never a match on the text `/compact`: a user may type that
   * string as prose, and an AUTOMATIC compaction lands in the middle of a turn
   * doing real work, which must still announce itself.
   */
  housekeeping?: boolean;
  /**
   * True when this status is being HANDED BACK rather than newly reached —
   * absent on every other announce.
   *
   * The one producer is the delegate lease expiring: it wrote a temporary
   * `running` over a run that had already settled, so handing the badge back is
   * a second non-terminal→terminal crossing for a turn that ended minutes ago.
   * Without this the client reads it as a fresh ending and fires another
   * banner and another sidebar mark — the same unwanted-notification complaint
   * {@link RunStatusEvent.housekeeping} exists for, arriving by a different
   * route. Separate from that flag because the two say different things: one is
   * about what the TURN was, this is about whether the status is news at all.
   *
   * A restore also carries no {@link RunStatusEvent.summary}. Every other
   * terminal write states the field, null included, so a wordless turn cannot
   * inherit the previous one's closing words; a restore is not a turn ending
   * and has nothing to say, so omitting it leaves the sentence the real settle
   * already gave the client standing instead of blanking it.
   */
  restored?: boolean;
  /**
   * The title this run has just been given — absent on every announce that did
   * not name it.
   *
   * Two states rather than the three its neighbours draw: the only producer
   * writes a title into a run that had none, so there is no "cleared" case to
   * express. A rename by the user travels as the PATCH's own response instead.
   *
   * It rides this event rather than a stream of its own because it needs exactly
   * what this event already provides — a broadcast to every client, reaching the
   * sidebar rows a user is not looking at, which is where a chat named a second
   * after its turn ended has to land.
   */
  /**
   * How full this run's context window was when its CLI last reported, and the
   * window that is measured against — ABSENT asserts nothing, a value sets.
   *
   * Stamped onto every status event by the bus rather than by any producer
   * (see `RunContextRegistry`), because the alternative had a client learning
   * the figure only two ways: the run list it fetched when its window opened,
   * and the live deltas of the ONE run it has joined. A thread working while
   * the user is on another chat is neither, so the ring drew an hour-old
   * number and only a hover — the readout asking the live CLI — corrected it.
   *
   * The count can be NULL beside a window: that is a compaction, whose
   * conversation is gone while the model's window is not. The pair travels
   * together for that reason, so a client cannot end up scaling a fresh count
   * against a window from before a model change.
   */
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  title?: string;
  /**
   * Whether a NAME for this run is being worked out right now — absent when this
   * announce says nothing about it.
   *
   * Three states like its neighbours: `undefined` asserts nothing, `true` says
   * an attempt is in flight, `false` says it has finished (named or not).
   *
   * It exists because the attempt is not instant and the wait is silent. Naming
   * a claude chat means a whole extra `-p` turn — measured at 3–7s after the
   * prompt was cut down, and 8–11s before — during which the sidebar row shows
   * the raw opening line and nothing says a better name is coming. REPORTED as
   * "I see it was updated, but it took LONG time. Like 30 sec", followed by
   * "while it's happening can we change thread title with some small
   * animation". This is the fact that animation is drawn from.
   *
   * Only the ASK raises it, never the free read of a title a CLI already wrote:
   * that one is a file open, and a shimmer nobody can see costs a re-render on
   * every announce.
   */
  titlePending?: boolean;
}

/**
 * The live text one agent has produced since its last DURABLE item — the
 * ephemeral plane behind a growing bubble.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/live-text.ts` reads this shape off
 * the `agent_delta` Socket.IO event. It is deliberately outside the generated
 * HTTP contract (no route carries it, so no OpenAPI schema exists), which is
 * why the two sides are independent implementations — a shape change here MUST
 * be mirrored there.
 *
 * `text` is the WHOLE tail, not an increment: a client that missed a delta is
 * correct again on the next one, and an empty string means "that block is
 * durable now, stop showing it". Nothing here is ever persisted or replayed.
 */
export interface RunDeltaEvent {
  runId: string;
  /** Owning graph node; null for a 1:1 chat's single agent. */
  nodeId: string | null;
  text: string;
  /**
   * Reasoning tokens spent in the CURRENT stretch, or null when the agent is
   * not (or no longer) thinking.
   *
   * Rides the SAME event as the text tail rather than a second channel: both
   * answer "what is this agent doing right now", both are ephemeral, and one
   * mechanism cannot get out of sync with itself. Null for a CLI that
   * discloses the words instead — see {@link RunDeltaEvent.thinkingText}.
   *
   * PER STRETCH, not cumulative over the turn: a turn that thinks, runs tools,
   * then thinks again is two separate waits, and each is shown as its own row
   * with its own count. A turn total spanning them read as one endless
   * "thinking" whose number never went back to zero.
   */
  thinkingTokens: number | null;
  /**
   * What the agent is thinking, as it thinks it — or null when there is
   * nothing to show.
   *
   * The whole tail of the CURRENT stretch, never an increment, exactly like
   * {@link RunDeltaEvent.text}: a client that missed an event is correct again
   * on the next one.
   *
   * The two reasoning channels are alternatives, not a pair, and which one a
   * turn uses is a property of the CLI: claude REDACTS its thinking and reports
   * `thinkingTokens`, cursor streams the words and fills this. Null therefore
   * means "no text", never "not thinking" — `thinkingStretch` is what answers
   * that, for both.
   */
  thinkingText: string | null;
  /**
   * Epoch ms when the CURRENT reasoning stretch began, or null when the agent
   * is not reasoning right now.
   *
   * A timestamp rather than an elapsed number so the client owns the clock: a
   * duration computed here would be frozen at publish time and would need a
   * delta per second to keep ticking.
   */
  thinkingSince: number | null;
  /**
   * Which reasoning stretch of this turn the two fields above describe,
   * counting from 1 — or null when the agent is not reasoning.
   *
   * The value carries no meaning of its own; it exists so a client can tell a
   * NEW stretch from more deltas about the current one. Without it, two
   * stretches separated by tool calls are indistinguishable on the wire from
   * one long stretch, and a renderer has nothing to key a fresh row on.
   */
  thinkingStretch: number | null;
  /**
   * Prompt-side tokens as of the turn's most recent request — how full the
   * window is RIGHT NOW.
   *
   * Mid-turn, unlike the `turn_complete` payload the meter used to be limited
   * to. Null before the turn's first `assistant` line, or for a CLI that
   * reports no per-request usage.
   */
  contextTokens: number | null;
  /**
   * The window `contextTokens` is measured against, as last reported for this
   * run. Remembered across turns AND across runs on the same model, because it
   * rides the `result` line only and a turn's first request has none of its
   * own. Null until some turn — this run's, or an earlier one on the same
   * model this session — has reported one.
   */
  contextWindowTokens: number | null;
}

/**
 * What a run is parked on, when it is parked on the user at all.
 *
 * Two kinds rather than a boolean because they are different asks and the
 * badge says so: a QUESTION is the agent wanting a decision only the user can
 * make, an APPROVAL is a tool call held at the permission gate. Both stop the
 * turn dead; only one of them means the agent has something to ask.
 *
 * Deliberately NOT a `RunStatus` value. The run genuinely is still running —
 * its process is alive, its turn is open, and every settle path still has to
 * fire — so writing this into the persisted lifecycle column would mean a
 * crash could strand a run in a state no settle path knows how to leave. It is
 * a live fact about an in-memory registry entry, and it is served like one.
 */
export const RunAwaitingSchema = z
  .enum(['question', 'approval'])
  .meta({ id: 'RunAwaiting' });
export type RunAwaiting = z.infer<typeof RunAwaitingSchema>;

/**
 * The hues a sidebar group can wear.
 *
 * NAMES, not colour values, and that is a hard constraint rather than a style
 * preference: the renderer's eslint config makes a literal hex/rgb/hsl an ERROR
 * anywhere under `apps/ui/src/renderer/**`, so a colour sent over the wire
 * would arrive at a call site that is forbidden to use it. Each name resolves
 * to a design token in `styles/global.css`, which is the one place colour
 * values are allowed to exist.
 *
 * The eight are the palette the app already ships (`--avatar-1..8`, mirrored
 * from geniro web) rather than a second set invented here, so a group and an
 * agent avatar can never drift into two different blues.
 */
export const RUN_GROUP_COLORS = [
  'blue',
  'purple',
  'green',
  'orange',
  'pink',
  'indigo',
  'teal',
  'red',
] as const;
export const RunGroupColorSchema = z
  .enum(RUN_GROUP_COLORS)
  .meta({ id: 'RunGroupColor' });
export type RunGroupColor = z.infer<typeof RunGroupColorSchema>;

/** How long a group's name may be — a sidebar label, not a description. */
export const RUN_GROUP_NAME_MAX = 60;

/**
 * One sidebar group on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 */
export const RunGroupWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: RunGroupColorSchema,
  position: z
    .number()
    .int()
    .describe('Sidebar order, ascending and contiguous from 0'),
  collapsed: z.boolean(),
  autoCwd: z
    .string()
    .nullable()
    .describe(
      'Canonical project folder whose new chats file themselves here — a run started in it, or anywhere inside it, matches; null for a group filled by hand',
    ),
});
export type RunGroupWire = z.infer<typeof RunGroupWireSchema>;

/**
 * A config directory the run's FOLDER pins, overriding the profile the chat was
 * pointed at.
 *
 * On the wire because the app must not go on naming a profile the agent is not
 * on — see `adapters/adapter.types.ts`'s `ConfigDirPin` for the measurement and
 * the report behind it. Named, because the header renders it and the generated
 * client should carry a type rather than an inline object.
 */
export const ConfigDirPinSchema = z
  .object({
    effective: z
      .string()
      .describe('The config directory the CLI will actually use'),
    source: z
      .string()
      .describe('The settings file that pinned it — a path the user can open'),
  })
  .meta({ id: 'ConfigDirPin' });
export type ConfigDirPinWire = z.infer<typeof ConfigDirPinSchema>;

/** A run projected to the wire (chat and workflow runs share the shape). */
/**
 * One pull request a run OPENED, as captured from the agent's own output.
 *
 * The IDENTITY only — owner, repo, number, url. Deliberately no title and no
 * state: those change on GitHub's side after the capture (a pull request is
 * reviewed, merged, closed), and a copy stored here would be a second, stale
 * answer sitting beside the live one the UI already reads with `gh`. What the
 * daemon knows and nothing else can recover is WHICH pull requests belong to
 * this thread; what they currently are is a live question.
 *
 * `owner`/`repo` rather than a folder, because a thread routinely spans several
 * repositories — `cd ../mobile-app && gh pr create` — and the URL is the only
 * thing that survives that. It is also self-sufficient: `gh pr view <url>`
 * resolves from any working directory, so the UI never has to know where the
 * work happened.
 *
 * `seq` is the transcript position the URL was captured at — the order the
 * thread opened them, and the dedupe key's tie-breaker. See
 * `utils/pull-request-capture.ts`.
 */
export const RunPullRequestSchema = z
  .object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int(),
    url: z.string(),
    seq: z.number().int(),
  })
  .meta({ id: 'RunPullRequest' });
export type RunPullRequest = z.infer<typeof RunPullRequestSchema>;

export const RunWireSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  /**
   * Parked on the user, and on what — null when it is not.
   *
   * On the SNAPSHOT as well as the `run_status` broadcast, because the two
   * cover different moments: the broadcast carries the transition, and this
   * carries the state a client that reconnected AFTER it has no other way to
   * learn. A run parked on a question emits nothing further by definition, so
   * without it a reloaded window shows a spinner until the user clicks in.
   */
  awaiting: RunAwaitingSchema.nullable().describe(
    'What this run is parked on waiting for the user, or null when it is not parked',
  ),
  /**
   * How many units of background work this run's turn is being HELD for — 0
   * when the agent is itself working, or when nothing is running at all.
   *
   * On the snapshot for exactly the reason {@link awaiting} is: the hold begins
   * with one announce and then lasts as long as the delegates do, so a window
   * that opened afterwards has nothing else to read it off — and it would put
   * the user's next message into a queue that will not drain for minutes.
   */
  holdingFor: z
    .number()
    .int()
    .min(0)
    .describe(
      'Units of background work this run is being held for; 0 when the agent itself is working',
    ),
  /**
   * How many DETACHED commands this run still has out — 0 when none.
   *
   * On the snapshot for the reason {@link holdingFor} is, and for a sharper
   * one: a detached command routinely OUTLIVES the turn that launched it, so a
   * window that opened afterwards has no turn, no event and no transcript of
   * its own to learn it from. Before this rode the row, the renderer folded it
   * out of the OPEN thread's items, which is knowable for one run and no other
   * — so a settled chat with a command still out badged itself `working` while
   * selected and `completed` the moment it was not.
   *
   * It says nothing about whether the turn is still going. A shell does not
   * hold a turn open, deliberately.
   */
  shellsOpen: z
    .number()
    .int()
    .min(0)
    .describe(
      'Detached commands this run still has running; 0 when none are out',
    ),
  title: z.string().nullable(),
  agentKind: AgentKindSchema.nullable(),
  workflowId: z
    .string()
    .nullable()
    .describe('Workflow slug for a graph run; null for a single-agent chat'),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  approval: ChatApprovalModeSchema.nullable().describe(
    'Chat approval mode; null = legacy row (no permission flags, pre-selector)',
  ),
  effort: z
    .string()
    .nullable()
    .describe(
      "Reasoning-effort level for the next turn, in the CLI's own vocabulary; null = the CLI's default (no --effort flag)",
    ),
  contextWindow: z
    .string()
    .nullable()
    .describe(
      "Which of the model's context-window sizes the next turn runs at, in the CLI's own vocabulary; null = the model's own default",
    ),
  modelParameters: z
    .record(z.string(), z.string())
    .describe(
      "Every OTHER model setting this run's next turn asks for, keyed by the CLI's own parameter id; {} when none are set. Sent back verbatim — geniro holds no vocabulary for these",
    ),
  contextTokens: z
    .number()
    .nullable()
    .describe(
      "How full the conversation's context window was when the CLI last reported — updated DURING a turn, so a client with no live reading draws the ring from this rather than from the last settled turn; null = never reported",
    ),
  contextWindowTokens: z
    .number()
    .nullable()
    .describe(
      'The window the tokens above are measured against, as the CLI reported it; null = never reported, in which case the ring is withheld rather than drawn against an assumed size',
    ),
  configDir: z
    .string()
    .nullable()
    .describe(
      "Canonical agent config directory this chat ASKED to run under — which account/profile its CLI was pointed at; null = the CLI's default. Set at creation and changeable through the settings PATCH, which moves the conversation with it",
    ),
  configDirPin: ConfigDirPinSchema.nullable().describe(
    "The config directory this run's FOLDER pins for this CLI, overriding the one above; null = nothing pins it, so the chat runs under the profile it names",
  ),
  groupId: z
    .string()
    .nullable()
    .describe(
      'Sidebar group this run is filed under; null for one sitting loose. Both run kinds carry it — the sidebar lists chats and workflow runs together',
    ),
  createdAt: z.string(),
  /**
   * Last write to the run row — every send flips status to `running` and every
   * settle writes the terminal status, so this is the run's last-activity time.
   *
   * It is also what the sidebar ORDERS on, which is why the same moment rides
   * the live channel as {@link RunStatusEvent.at}: a snapshot alone goes stale
   * the instant a thread the user is not looking at starts a turn.
   */
  updatedAt: z.string().describe("The run's last-activity time"),
  /**
   * Text of the run's latest `message` item (the chat list's preview line).
   * Null when the run has no messages yet; list endpoints enrich it, while
   * create paths return null (a fresh run genuinely has none).
   */
  lastMessage: z
    .string()
    .nullable()
    .describe("Text of the run's latest message item — the list preview line"),
  /**
   * The pull requests this run OPENED, oldest first.
   *
   * Captured from the transcript rather than derived from the checkout — see
   * {@link RunPullRequestSchema} and `utils/pull-request-capture.ts` for why
   * the branch a folder happens to have checked out cannot answer this.
   */
  pullRequests: z
    .array(RunPullRequestSchema)
    .describe(
      'Pull requests this run opened, oldest first, as captured from the agent output',
    ),
});
export type RunWire = z.infer<typeof RunWireSchema>;

/**
 * One conversation a CLI already holds on this machine, offered so the user can
 * carry it on inside geniro.
 *
 * `cwd` is nullable on the wire and NOT optional in practice: a session whose
 * folder the CLI never recorded cannot be resumed anywhere sensible, so the
 * picker offers it read-only rather than pretending a resume would work. Every
 * other field is a label.
 */
export const AgentSessionWireSchema = z
  .object({
    id: z.string().describe('The id the CLI resumes by'),
    cwd: z
      .string()
      .nullable()
      .describe(
        'Folder the conversation ran in; null when the CLI recorded none',
      ),
    title: z
      .string()
      .nullable()
      .describe("The CLI's own title, or the conversation's opening prompt"),
    updatedAt: z
      .number()
      .nullable()
      .describe('Epoch ms of the last write; null when the CLI records none'),
    snippet: z
      .string()
      .nullable()
      .describe(
        'The line of the conversation that answered the search; null when the title or the folder already explains the match',
      ),
  })
  // NESTED, never a response root — so an id here names the row type in the
  // generated client instead of leaving it `…DtoSessionsInner`. Compare
  // `AgentMcpServer` above, and the note on the listing below for what the same
  // id on a ROOT would cost.
  .meta({ id: 'AgentSession' });
export type AgentSessionWire = z.infer<typeof AgentSessionWireSchema>;

/**
 * The sessions listing, with the two things an empty list could mean.
 *
 * Both reasons are carried rather than folded into one, because they answer
 * different questions and a picker shows them in different places:
 * `unavailableReason` says the list could not be taken at all,
 * `partialReason` says it was taken and does not cover everything this CLI
 * holds — cursor's interactive chats live in a store its ACP server will not
 * open, and a user with months of terminal history needs to be told that rather
 * than left to conclude the feature is broken.
 */
export const AgentSessionListingWireSchema = z.object({
  sessions: z.array(AgentSessionWireSchema),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why this CLI could not be asked at all; null when it could'),
  partialReason: z
    .string()
    .nullable()
    .describe('What this listing does not reach; null when it reaches all'),
});
// No `.meta({ id })` on this one: it is a RESPONSE DTO ROOT, and nestjs-zod
// would then register the component under the id while the route still points
// at the DTO class name — the dangling `$ref` `setupSwagger` fails the boot on.
// The nested row above carries an id precisely because it is not a root.
export type AgentSessionListingWire = z.infer<
  typeof AgentSessionListingWireSchema
>;
