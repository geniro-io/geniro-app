import {
  CHART_KINDS,
  type ChartKind,
  HOST_CHART_TOOL,
  type HostChart,
  type HostChartOutcome,
  type HostChartSeries,
  MAX_CHART_LABEL_LENGTH,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  MAX_CHART_TITLE_LENGTH,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN chart tool.
 *
 * Auto-approved on the findings tool's reading: what the agent is asking to run
 * is the act of DRAWING in this app's own transcript. Nothing is written outside
 * the run's own history, so a permission card guarding it is a gate with nothing
 * behind it — and it would fire on every plot.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostChartCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_CHART_TOOL);
}

/** Trim to a cap without inventing content; an absent value stays absent. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * One plotted number, or null for a gap.
 *
 * A quoted number is accepted — a model writing JSON does sometimes send
 * `"12.1"`, and refusing it would blank a series over its punctuation. The
 * empty and whitespace strings are excluded explicitly because `Number('')` and
 * `Number(' ')` are both `0`, which would plant a measurement of zero where
 * there was no measurement at all.
 *
 * Anything non-finite becomes a gap rather than a point: `NaN` and `Infinity`
 * have no position on an axis, and recharts would silently collapse the whole
 * scale around them.
 */
function plotted(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * One x-axis category.
 *
 * A number is stringified rather than refused: years, ports, commit counts and
 * run numbers are all things a model reasonably sends unquoted for an axis that
 * is textual by contract.
 *
 * Anything else becomes the EMPTY string rather than being dropped, and that
 * distinction is the load-bearing one in this file: series values are read
 * positionally against this list, so removing a label would shift every later
 * point one place left and silently re-attribute every measurement after it.
 * A blank tick is a visible gap; a shifted axis is a wrong chart that looks
 * right.
 */
function axisLabel(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().slice(0, MAX_CHART_LABEL_LENGTH);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function chartKind(value: unknown): ChartKind {
  // Defaults rather than refuses, unlike the enum reads in `host-findings`:
  // there a bad `verdict` costs one badge, here a bad `kind` would cost the
  // whole plot. Every dataset this tool accepts can be drawn as a line, so the
  // default is the one that is never nonsense.
  return typeof value === 'string' &&
    (CHART_KINDS as readonly string[]).includes(value)
    ? (value as ChartKind)
    : 'line';
}

/**
 * Read a `show_chart` tool call's arguments into the chart the card plots, or
 * null when the payload does not read as a chart at all.
 *
 * Defensive rather than schema-validating, on the rule every host tool's reader
 * follows: the caller is a model, so a field can be anything, and the honest
 * answers are "here is what parsed" and "none of it did" — never a throw across
 * the transport.
 *
 * Null means there is nothing plottable: no x labels, or no series left with a
 * single measured point. That is a MALFORMED call rather than an empty result,
 * and the MCP branch answers it as one — unlike an empty findings report, which
 * is a real review outcome, a chart of nothing is only ever a mistake.
 */
export function readHostChart(args: Record<string, unknown>): HostChart | null {
  const rawLabels = args.labels;
  if (!Array.isArray(rawLabels) || rawLabels.length === 0) {
    return null;
  }
  const labels = rawLabels.slice(0, MAX_CHART_POINTS).map(axisLabel);
  const rawSeries = args.series;
  if (!Array.isArray(rawSeries)) {
    return null;
  }
  const series: HostChartSeries[] = [];
  for (const entry of rawSeries.slice(0, MAX_CHART_SERIES)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const s = entry as Record<string, unknown>;
    const name = text(s.name, MAX_CHART_LABEL_LENGTH);
    // Bound to a local before the guard, not read off `s` again below: a
    // narrowing on a mutable property does not survive into the closure, and
    // the compiler is right to say so.
    const raw = s.values;
    // A nameless curve cannot appear in the legend, and the legend is the only
    // thing that says which colour is which — so it is dropped rather than
    // drawn as an anonymous line.
    if (name === null || !Array.isArray(raw)) {
      continue;
    }
    // Aligned to the labels, always: a short series is padded with gaps and a
    // long one is cut. Either way every index still means the label at that
    // index, which is the guarantee the whole positional shape rests on.
    const values = labels.map((_, index) => plotted(raw[index]));
    if (values.every((value) => value === null)) {
      continue;
    }
    series.push({ name, values });
  }
  if (series.length === 0) {
    return null;
  }
  const title = text(args.title, MAX_CHART_TITLE_LENGTH);
  const xLabel = text(args.x_label, MAX_CHART_LABEL_LENGTH);
  const yLabel = text(args.y_label, MAX_CHART_LABEL_LENGTH);
  return {
    kind: chartKind(args.kind),
    labels,
    series,
    ...(title === null ? {} : { title }),
    ...(xLabel === null ? {} : { xLabel }),
    ...(yLabel === null ? {} : { yLabel }),
  };
}

/**
 * The tool result text for one outcome.
 *
 * A RECEIPT, never the numbers — the point of a host-drawn chart is that the
 * data goes to the screen instead of back through the model's window, and
 * echoing the series here would put every point in it twice.
 *
 * The counts are said because the caps truncate silently: an agent that sent
 * seven series reads back five and knows, without being handed its own data.
 */
export function hostChartResultText(outcome: HostChartOutcome): string {
  if (outcome.status === 'unavailable') {
    return `The chart could not be drawn (${outcome.reason}). Describe the numbers in your reply instead.`;
  }
  const pointNoun = outcome.points === 1 ? 'point' : 'points';
  // "series" is its own plural, so only the points need counting out.
  return `Chart drawn for the user: ${outcome.series} series over ${outcome.points} ${pointNoun}.`;
}
