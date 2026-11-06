export function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The text of a result that arrives bare, as MCP content blocks, or wrapped. */
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

/** The reason after a refusal's `CODE: ` prefix, or the line itself. */
export function refusalReason(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  const match = /^[A-Z][A-Z_]+: (.+)$/.exec(line);
  return match?.[1] ?? line;
}
