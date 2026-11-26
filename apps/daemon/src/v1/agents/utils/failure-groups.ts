/** How long an error signature is kept. */
const SIGNATURE_CHARS = 120;

/** How many of a group's calls it names. */
export const FAILURE_GROUP_EXAMPLES = 3;

/** Keys a JSON error body names its message under, most telling first. */
const ERROR_KEYS = ['error', 'message', 'code', 'reason'] as const;

/**
 * What a failed call's error says, with the parts that differ between two
 * calls failing for one reason masked: ids, paths, quoted text and numbers.
 * A JSON body is read for its error message first; otherwise the first line
 * that says anything.
 */
export function errorSignature(text: string): string {
  const stripped = text.replace(/<\/?tool_use_error>/g, '').trim();
  const line =
    jsonErrorOf(stripped) ??
    stripped
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ??
    '';
  const masked = line
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<id>',
    )
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/(?:~|\.{1,2})?\/[^\s'"`:,)\]]+/g, '<path>')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '<q>')
    .replace(/\d+/g, '#');
  return masked.length > SIGNATURE_CHARS
    ? `${masked.slice(0, SIGNATURE_CHARS)}…`
    : masked;
}

function jsonErrorOf(text: string): string | null {
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
  if (first === null || typeof first !== 'object') {
    return null;
  }
  const record = first as Record<string, unknown>;
  for (const key of ERROR_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().split('\n')[0]!;
    }
  }
  return null;
}

/** One failed call as the groups count it. */
export interface FailedCall {
  runId: string;
  /** The call's own row. */
  seq: number;
  /** The row of the result that failed. */
  resultSeq: number;
  at: string;
  tool: string;
  error: string;
}

/** Every failed call of one tool failing for one reason. */
export interface FailureGroup {
  tool: string;
  signature: string;
  count: number;
  threads: number;
  firstAt: string;
  lastAt: string;
  /** At most {@link FAILURE_GROUP_EXAMPLES} of its calls, from as many threads as it has. */
  examples: { runId: string; seq: number }[];
  /** The first call's error text, clipped, naming the row that holds it whole. */
  error: string;
}

/**
 * The calls grouped by tool and error signature, largest group first; ties by
 * tool, then signature. Every call is counted; only the examples are capped,
 * and they come from as many threads as the group has.
 */
export function groupFailures(
  calls: readonly FailedCall[],
  errorChars: number,
): FailureGroup[] {
  const groups = new Map<
    string,
    {
      group: FailureGroup;
      runs: Set<string>;
      spare: { runId: string; seq: number }[];
    }
  >();
  for (const call of calls) {
    const signature = errorSignature(call.error);
    const key = `${call.tool}\u0000${signature}`;
    const entry = groups.get(key) ?? {
      group: {
        tool: call.tool,
        signature,
        count: 0,
        threads: 0,
        firstAt: call.at,
        lastAt: call.at,
        examples: [],
        error:
          call.error.length <= errorChars
            ? call.error
            : `${call.error.slice(0, errorChars)}… [view=item runId=${call.runId} seq=${call.resultSeq}]`,
      },
      runs: new Set<string>(),
      spare: [],
    };
    const { group } = entry;
    group.count += 1;
    group.firstAt = call.at < group.firstAt ? call.at : group.firstAt;
    group.lastAt = call.at > group.lastAt ? call.at : group.lastAt;
    const ref = { runId: call.runId, seq: call.seq };
    if (!entry.runs.has(call.runId)) {
      entry.runs.add(call.runId);
      if (group.examples.length < FAILURE_GROUP_EXAMPLES) {
        group.examples.push(ref);
      }
    } else if (entry.spare.length < FAILURE_GROUP_EXAMPLES) {
      entry.spare.push(ref);
    }
    groups.set(key, entry);
  }
  return [...groups.values()]
    .map(({ group, runs, spare }) => ({
      ...group,
      threads: runs.size,
      examples: [...group.examples, ...spare].slice(0, FAILURE_GROUP_EXAMPLES),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.tool.localeCompare(b.tool) ||
        a.signature.localeCompare(b.signature),
    );
}
