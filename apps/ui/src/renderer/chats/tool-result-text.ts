export function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The text of a result that arrives bare, as MCP content blocks, or wrapped.
 *
 * TWIN PARSER: `resultTextOf` in `apps/daemon/src/v1/memory/utils/memory-usage-history.ts`.
 */
export function resultTextOf(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const texts = result.flatMap((block) => {
      const text = recordOf(block)?.text;
      return typeof text === 'string' ? [text] : [];
    });
    return texts.length > 0 ? texts.join('\n') : null;
  }
  const record = recordOf(result);
  return record === null ? null : resultTextOf(record.content);
}

/**
 * A tool call's arguments. A CLI may wrap an MCP call's as
 * `{toolName, args}`, keeping the tool's own one level down.
 */
export function toolCallArgsOf(
  payload: unknown,
): Record<string, unknown> | null {
  const input = recordOf(recordOf(payload)?.input);
  return (
    (typeof input?.toolName === 'string' ? recordOf(input.args) : null) ?? input
  );
}

/** The reason after a refusal's `CODE: ` prefix, or the line itself. */
export function refusalReason(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  const match = /^[A-Z][A-Z_]+: (.+)$/.exec(line);
  return match?.[1] ?? line;
}
