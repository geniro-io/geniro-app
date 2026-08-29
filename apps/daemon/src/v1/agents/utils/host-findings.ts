import {
  FINDING_LEVELS,
  FINDING_OUTCOMES,
  FINDING_VERDICTS,
  type FindingLevel,
  type FindingOutcome,
  type FindingVerdict,
  HOST_FINDINGS_TOOL,
  type HostFinding,
  type HostFindingsOutcome,
  type HostFindingsReport,
  MAX_FINDING_CATEGORY_LENGTH,
  MAX_FINDING_PATH_LENGTH,
  MAX_FINDING_SHORT_SUMMARY_LENGTH,
  MAX_FINDING_TEXT_LENGTH,
  MAX_HOST_FINDINGS,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN findings tool.
 *
 * Approved for the user on the same reading as the question tool: what the
 * agent is asking to run is the act of DRAWING something in this app's own
 * transcript. There is no side effect behind the press — nothing is written
 * outside the run's own history — so a card asking permission to render a card
 * is a gate with nothing behind it, and it would fire on every report.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostFindingsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_FINDINGS_TOOL);
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
 * A 1-indexed source line, or null.
 *
 * Anything that is not a positive integer is dropped rather than coerced: the
 * number is shown to the user as a location, and a rounded or zeroed one would
 * point confidently at the wrong place.
 */
function lineNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Read a `report_findings` tool call's arguments into the report the card draws.
 *
 * Defensive rather than schema-validating, on the same rule
 * {@link readHostQuestions} follows: the caller is a model, so a field can be
 * anything at all, and the honest answers are "here is what parsed" and "none of
 * it did" — never a throw across the transport.
 *
 * This is also the ONE place the naming seam is crossed. The tool advertises
 * claude's `ReportFindings` field names so an agent that knows that tool needs
 * to learn nothing new; everything the daemon holds past this function is
 * camelCase. A finding missing `file` or `summary` is DROPPED — those two are
 * what a row IS, and a row with neither has nothing to render — while a missing
 * `failure_scenario` only costs that finding its expanded detail.
 */
export function readHostFindingsReport(
  args: Record<string, unknown>,
): HostFindingsReport {
  const level: FindingLevel | null = oneOf(args.level, FINDING_LEVELS);
  const raw = args.findings;
  if (!Array.isArray(raw)) {
    return { findings: [], ...(level === null ? {} : { level }) };
  }
  const findings: HostFinding[] = [];
  for (const entry of raw.slice(0, MAX_HOST_FINDINGS)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const f = entry as Record<string, unknown>;
    const file = text(f.file, MAX_FINDING_PATH_LENGTH);
    const summary = text(f.summary, MAX_FINDING_TEXT_LENGTH);
    if (file === null || summary === null) {
      continue;
    }
    const line = lineNumber(f.line);
    const shortSummary = text(
      f.short_summary,
      MAX_FINDING_SHORT_SUMMARY_LENGTH,
    );
    const failureScenario = text(f.failure_scenario, MAX_FINDING_TEXT_LENGTH);
    const category = text(f.category, MAX_FINDING_CATEGORY_LENGTH);
    const verdict: FindingVerdict | null = oneOf(f.verdict, FINDING_VERDICTS);
    const outcome: FindingOutcome | null = oneOf(f.outcome, FINDING_OUTCOMES);
    findings.push({
      file,
      summary,
      ...(line === null ? {} : { line }),
      ...(shortSummary === null ? {} : { shortSummary }),
      ...(failureScenario === null ? {} : { failureScenario }),
      ...(category === null ? {} : { category }),
      ...(verdict === null ? {} : { verdict }),
      ...(outcome === null ? {} : { outcome }),
    });
  }
  return { findings, ...(level === null ? {} : { level }) };
}

/**
 * The tool result text for one outcome.
 *
 * Deliberately a RECEIPT rather than the findings themselves: the whole point
 * of a host-rendered card is that the data goes to the screen instead of back
 * through the model's context, and echoing it here would put every finding into
 * the window twice — once as the call, once as its result.
 */
export function hostFindingsResultText(outcome: HostFindingsOutcome): string {
  if (outcome.status === 'unavailable') {
    return `The findings could not be recorded (${outcome.reason}). Report them in your reply instead.`;
  }
  if (outcome.count === 0) {
    return 'No findings recorded.';
  }
  const noun = outcome.count === 1 ? 'finding' : 'findings';
  return `${outcome.count} ${noun} recorded and shown to the user.`;
}
