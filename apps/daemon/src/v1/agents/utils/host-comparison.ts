import {
  HOST_COMPARISON_TOOL,
  type HostComparison,
  type HostComparisonCell,
  type HostComparisonCriterion,
  type HostComparisonOption,
  type HostComparisonOutcome,
  MAX_COMPARISON_CELL_LENGTH,
  MAX_COMPARISON_CRITERIA,
  MAX_COMPARISON_LABEL_LENGTH,
  MAX_COMPARISON_OPTIONS,
  MAX_COMPARISON_REASON_LENGTH,
  type Sentiment,
  SENTIMENTS,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN comparison tool.
 *
 * Auto-approved like every tool in this family: what the agent would be asking
 * permission for is the act of drawing in this app's own transcript.
 */
export function isHostComparisonCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_COMPARISON_TOOL);
}

/** One trimmed, capped string, or null when there is nothing usable there. */
function text(value: unknown, cap: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, cap);
}

/**
 * Cap PROSE, at a word boundary, saying so with an ellipsis.
 *
 * The plain `slice` every other field uses is right for a phrase and wrong
 * here. Observed on a live turn: a recommendation ran a little past 300
 * characters and the card ended "…and where migrati" — which does not read as
 * a truncation, it reads as the app corrupting the agent's answer, and the
 * answer is the most important thing on the card.
 *
 * The ellipsis is the load-bearing half. Cutting at a word boundary alone
 * produces a sentence that simply stops, and a reader has no way to tell that
 * from an agent trailing off mid-thought.
 */
function truncateWords(value: string, cap: number): string {
  if (value.length <= cap) {
    return value;
  }
  const cut = value.slice(0, cap);
  const lastSpace = cut.lastIndexOf(' ');
  // A single word longer than the cap has no boundary to cut at; slicing it is
  // then the only option, and the ellipsis still says what happened.
  return `${(lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Read one option, or null when it has no name.
 *
 * A nameless column cannot be a column: every cell beneath it would be an
 * answer about nothing, and the recommendation could never point at it.
 */
function readOption(entry: unknown): HostComparisonOption | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const raw = entry as { name?: unknown; note?: unknown };
  const name = text(raw.name, MAX_COMPARISON_LABEL_LENGTH);
  if (name === null) {
    return null;
  }
  const note = text(raw.note, MAX_COMPARISON_CELL_LENGTH);
  return { name, ...(note === null ? {} : { note }) };
}

/**
 * Read one cell — ALWAYS a cell, never null.
 *
 * The positional rule, and the whole reason this returns a blank instead of
 * nothing: a cell's index is which option it answers for. Dropping an
 * unreadable one would shift every cell after it one column left, filing each
 * option's answer under its neighbour's name — a failure that does not throw
 * and still looks like a comparison. A blank says "nothing here" honestly.
 */
function readCell(entry: unknown): HostComparisonCell {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    // A bare string is a generous reading of the commonest malformed shape —
    // cells written as plain values rather than objects — and costs nothing:
    // it carries a value and no verdict, which is exactly what it means.
    const bare = text(entry, MAX_COMPARISON_CELL_LENGTH);
    return { value: bare ?? '' };
  }
  const raw = entry as { value?: unknown; verdict?: unknown };
  const value = text(raw.value, MAX_COMPARISON_CELL_LENGTH);
  // An unrecognised verdict falls back to ABSENT rather than to `bad`, on the
  // scorecard's rule: it only paints a cell, and a misspelling must not paint a
  // winning option red.
  const verdict =
    typeof raw.verdict === 'string' &&
    (SENTIMENTS as readonly string[]).includes(raw.verdict)
      ? (raw.verdict as Sentiment)
      : undefined;
  return {
    value: value ?? '',
    ...(verdict === undefined ? {} : { verdict }),
  };
}

/**
 * Read one criterion against a known option count, or null when it has no
 * label.
 *
 * Re-aligned to `optionCount` here rather than trusted: a row the model sent
 * short would otherwise leave the last option looking un-assessed, and a long
 * one would carry a cell no column can show. Padding and cutting is the same
 * treatment the chart gives a series against its labels, for the same reason.
 */
function readCriterion(
  entry: unknown,
  optionCount: number,
): HostComparisonCriterion | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const raw = entry as { label?: unknown; cells?: unknown };
  const label = text(raw.label, MAX_COMPARISON_LABEL_LENGTH);
  if (label === null) {
    return null;
  }
  const cells = Array.isArray(raw.cells) ? raw.cells : [];
  return {
    label,
    cells: Array.from({ length: optionCount }, (_, index) =>
      readCell(cells[index]),
    ),
  };
}

/**
 * Read a `show_comparison` call's arguments.
 *
 * Null when there is nothing to draw, which the MCP host answers as a malformed
 * call — the chart's rule, since a comparison of fewer than two options is not
 * a comparison and a table with no rows compares them on nothing.
 *
 * TWO options is the floor and it is a real check rather than a formality: a
 * one-column "comparison" is the shape a model produces when it has decided
 * before it has compared, and drawing it would dress that up as an analysis.
 */
export function readHostComparison(
  args: Record<string, unknown>,
): HostComparison | null {
  const title = text(args.title, MAX_COMPARISON_LABEL_LENGTH);
  if (title === null || !Array.isArray(args.options)) {
    return null;
  }
  const options: HostComparisonOption[] = [];
  for (const entry of args.options) {
    if (options.length >= MAX_COMPARISON_OPTIONS) {
      break;
    }
    const option = readOption(entry);
    if (option !== null) {
      options.push(option);
    }
  }
  if (options.length < 2 || !Array.isArray(args.criteria)) {
    return null;
  }
  const criteria: HostComparisonCriterion[] = [];
  for (const entry of args.criteria) {
    if (criteria.length >= MAX_COMPARISON_CRITERIA) {
      break;
    }
    const criterion = readCriterion(entry, options.length);
    if (criterion !== null) {
      criteria.push(criterion);
    }
  }
  if (criteria.length === 0) {
    return null;
  }
  return {
    title,
    options,
    criteria,
    ...readRecommendation(args.recommendation),
  };
}

/**
 * The recommendation, when both halves are there.
 *
 * BOTH, deliberately: a named option with no reason is an assertion the reader
 * cannot weigh, and a reason naming no option is a paragraph. Either alone is
 * dropped rather than half-drawn. The name is NOT checked against the options
 * here — the card does that when it decides which column to highlight, and a
 * name that matches nothing still leaves a reason worth reading.
 */
function readRecommendation(
  value: unknown,
): Pick<HostComparison, 'recommendation'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as { option?: unknown; reason?: unknown };
  const option = text(raw.option, MAX_COMPARISON_LABEL_LENGTH);
  // Read UNCAPPED, then cut as prose — `text`'s own slice would land mid-word.
  const rawReason = text(raw.reason, Number.MAX_SAFE_INTEGER);
  const reason =
    rawReason === null
      ? null
      : truncateWords(rawReason, MAX_COMPARISON_REASON_LENGTH);
  return option === null || reason === null
    ? {}
    : { recommendation: { option, reason } };
}

/**
 * The tool result text for one outcome — a RECEIPT, never the table.
 *
 * The "do not repeat" line is worth more here than on the other drawings: a
 * comparison is exactly the thing a model likes to summarize back in prose, and
 * a card followed by the same table written out is the worst of both.
 */
export function hostComparisonResultText(
  outcome: HostComparisonOutcome,
): string {
  if (outcome.status === 'unavailable') {
    return `The comparison could not be shown (${outcome.reason}). Put it in your reply instead.`;
  }
  return `Comparison drawn for the user: ${outcome.options} options over ${outcome.criteria} criteria. Do not repeat the table in your reply — say what you would pick and why, or answer their next question.`;
}
