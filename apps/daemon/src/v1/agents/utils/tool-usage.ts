import type { RunWaterfallToolUse } from '../chat.types';

/**
 * One row of the tool histogram as SQLite groups it — before a row that names
 * the CALL rather than the TOOL has been collapsed.
 */
export interface ToolUsageGroup {
  nodeId: string | null;
  /** `payload.name` — a tool's name on one CLI, a per-call TITLE on another. */
  name: string;
  /** `payload.toolKind` — the shared classifier's own word for what it does. */
  toolKind: string | null;
  calls: number;
}

/**
 * The longest thing that can still be a tool's NAME.
 *
 * Measured across a real profile rather than chosen: the longest genuine name
 * on it is `mcp__claude_ai_Manifest_OS_Google_Workspace__bigquery_list_dataset_ids`
 * at 70 characters, and every MCP tool a server exposes is that shape.
 */
export const MAX_TOOL_NAME_CHARS = 80;

/**
 * A tool NAME is an identifier, not prose and not a command.
 *
 * It must OPEN with a letter, digit or underscore — which is what excludes the
 * backtick every shell title on this wire begins with — and may then carry only
 * the characters a tool name is made of. No colon (a `Task: <the brief>` title
 * has one), no backtick, no quote, no newline.
 */
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9 _./-]*$/;

/** The label for a row whose CLI named neither the tool nor its kind. */
const UNNAMED_TOOL = 'tool';

/**
 * Which TOOL a call was, from a row that may have named the CALL instead.
 *
 * `payload.name` is a tool's name on claude (`Bash`, `Edit`,
 * `mcp__geniro-…__await_agent`) and, on the ACP transport, whatever the CLI
 * TITLED the call — which for a shell call is the command itself, backticked.
 * MEASURED on a real database: 3,251 such rows, the longest 37,630 characters,
 * and on the run this was written against a single cursor node produced 64
 * distinct "names" for 64 shell calls.
 *
 * Both halves of that are defects in a histogram. The wire caps a label at
 * `MAX_WATERFALL_LABEL_CHARS`, so an argument-carrying title made the whole
 * response fail validation; and a table keyed on one claims the agent called
 * sixty-four different tools when it called one tool sixty-four times.
 *
 * So a name that cannot BE a name is answered with the call's KIND — the word
 * `tool-kind.ts` already classified it under, which is the most this daemon
 * honestly knows about such a row. It is never a guess at the tool's name: the
 * kinds are their own vocabulary (`execute`, `read`, `edit`, `search`, …) and
 * read as the category they are.
 */
export function toolLabel(name: string, toolKind: string | null): string {
  const trimmed = name.trim();
  if (
    trimmed.length > 0 &&
    trimmed.length <= MAX_TOOL_NAME_CHARS &&
    TOOL_NAME.test(trimmed)
  ) {
    return trimmed;
  }
  const kind = toolKind?.trim() ?? '';
  return kind.length > 0 ? kind : UNNAMED_TOOL;
}

/**
 * The grouped rows folded into the histogram the card draws: one row per
 * (lane, tool label), busiest first, capped.
 *
 * Re-aggregating here rather than in SQL is what the collapse above forces —
 * sixty-four titles become one `execute` row, and their counts have to be
 * SUMMED rather than the largest of them kept.
 */
export function foldToolUsage(
  groups: ToolUsageGroup[],
  limit: number,
): { toolUse: RunWaterfallToolUse[]; capped: boolean } {
  const byLabel = new Map<string, RunWaterfallToolUse>();
  for (const group of groups) {
    const name = toolLabel(group.name, group.toolKind);
    const key = `${group.nodeId ?? ''}\u0000${name}`;
    const seen = byLabel.get(key);
    if (seen === undefined) {
      byLabel.set(key, { nodeId: group.nodeId, name, calls: group.calls });
      continue;
    }
    seen.calls += group.calls;
  }
  // Busiest first, then by name — a stable order, so two reads of one settled
  // run cannot shuffle the table's rows past each other.
  const rows = [...byLabel.values()].sort(
    (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
  );
  return { toolUse: rows.slice(0, limit), capped: rows.length > limit };
}
