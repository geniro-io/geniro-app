import {
  HOST_METRICS_TOOL,
  type HostMetric,
  type HostMetrics,
  type HostMetricsOutcome,
  MAX_HOST_METRICS,
  MAX_METRIC_LABEL_LENGTH,
  MAX_METRIC_NOTE_LENGTH,
  MAX_METRIC_VALUE_LENGTH,
  METRIC_SENTIMENTS,
  type MetricSentiment,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN scorecard tool.
 *
 * Auto-approved like every tool in this family: what the agent would be asking
 * permission for is the act of drawing in this app's own transcript, and a gate
 * there is a press with nothing behind it.
 */
export function isHostMetricsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_METRICS_TOOL);
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
 * Read one figure, or null when it carries none.
 *
 * A row needs BOTH a label and a value: a figure with no caption is a number
 * the reader cannot attribute, and a caption with no figure is a card row that
 * measures nothing. Either alone is dropped rather than drawn blank — nothing
 * here is positional (unlike a chart's values, where a dropped point shifts
 * every later one), so a missing row leaves no hole.
 *
 * The value is NOT coerced from a number. Accepting one would look generous and
 * would quietly re-introduce the formatting decision this tool exists to leave
 * with the agent — `0.82` would render as `0.82` where the agent meant `82%`,
 * and it would be the host's fault while looking like the model's.
 */
function readMetric(entry: unknown): HostMetric | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const raw = entry as {
    label?: unknown;
    value?: unknown;
    delta?: unknown;
    sentiment?: unknown;
    note?: unknown;
  };
  const label = text(raw.label, MAX_METRIC_LABEL_LENGTH);
  const value = text(raw.value, MAX_METRIC_VALUE_LENGTH);
  if (label === null || value === null) {
    return null;
  }
  const delta = text(raw.delta, MAX_METRIC_VALUE_LENGTH);
  const note = text(raw.note, MAX_METRIC_NOTE_LENGTH);
  // An unrecognised sentiment falls back to ABSENT rather than to `bad`: this
  // field only colours a figure, and a misspelling must not paint a good result
  // red. `neutral` is what the card draws for an absent one anyway.
  const sentiment =
    typeof raw.sentiment === 'string' &&
    (METRIC_SENTIMENTS as readonly string[]).includes(raw.sentiment)
      ? (raw.sentiment as MetricSentiment)
      : undefined;
  return {
    label,
    value,
    ...(delta === null ? {} : { delta }),
    ...(sentiment === undefined ? {} : { sentiment }),
    ...(note === null ? {} : { note }),
  };
}

/**
 * Read a `show_metrics` call's arguments.
 *
 * Null when nothing readable is there at all, which the MCP host answers as a
 * malformed call. That is the CHART's rule rather than the findings tool's, and
 * for the chart's reason: an empty findings report is a real review outcome —
 * "nothing survived verification" — while a scorecard with no figures is only
 * ever a mistake, and answering it as a drawn card would have the agent believe
 * its numbers are on screen.
 */
export function readHostMetrics(
  args: Record<string, unknown>,
): HostMetrics | null {
  if (!Array.isArray(args.metrics)) {
    return null;
  }
  const metrics: HostMetric[] = [];
  for (const entry of args.metrics) {
    if (metrics.length >= MAX_HOST_METRICS) {
      break;
    }
    const metric = readMetric(entry);
    if (metric !== null) {
      metrics.push(metric);
    }
  }
  if (metrics.length === 0) {
    return null;
  }
  const title = text(args.title, MAX_METRIC_LABEL_LENGTH);
  return { ...(title === null ? {} : { title }), metrics };
}

/**
 * The tool result text for one outcome — a RECEIPT, never the figures.
 *
 * Echoing them back is what would put the same numbers in the model's window
 * twice, which is the whole thing this family avoids. The count is here because
 * the cap truncates silently: an agent that sent twelve and reads "8" knows.
 */
export function hostMetricsResultText(outcome: HostMetricsOutcome): string {
  if (outcome.status === 'unavailable') {
    return `The figures could not be shown (${outcome.reason}). Put them in your reply instead.`;
  }
  return `Scorecard drawn for the user: ${outcome.count} ${outcome.count === 1 ? 'figure' : 'figures'}. Do not repeat the numbers in your reply — say what they mean.`;
}
