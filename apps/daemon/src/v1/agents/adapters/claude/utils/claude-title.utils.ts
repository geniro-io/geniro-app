/**
 * The title this CLI wrote, read back out of its `--output-format json` reply.
 *
 * One object, not a stream: `{ …, "subtype": "success", "result": "<text>" }`,
 * with the model's answer in `result` and an `is_error` sibling on the failure
 * arm. Probed on 2.1.237.
 *
 * Every unreadable shape answers null rather than throwing — this feeds a
 * fallback that is already correct, so a CLI that changed its reply costs the
 * better title and nothing else.
 */
export function readClaudeTitleReply(stdout: string | null): string | null {
  if (stdout === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as { result?: unknown; is_error?: unknown };
  // A failed turn still answers 200-shaped JSON with its error text in the very
  // same field, so the flag is what tells an answer from a complaint.
  if (row.is_error === true) {
    return null;
  }
  const result = typeof row.result === 'string' ? row.result.trim() : '';
  return result === '' ? null : unwrapTitle(result);
}

/**
 * The title itself, with the packaging a model adds when it ignores the ask.
 *
 * Only the two forms that are unambiguously packaging: a whole answer inside
 * matching quotes, and a trailing full stop. Neither can be part of a title a
 * reader wanted — a name ending in `.` is not one, and a fully-quoted answer is
 * the model quoting itself — while anything more (stripping a leading `Title:`,
 * say) starts matching prose, which the prompt already asks against.
 */
function unwrapTitle(text: string): string {
  const dequoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('“') && text.endsWith('”')) ||
    (text.startsWith("'") && text.endsWith("'"))
      ? text.slice(1, -1).trim()
      : text;
  return dequoted.endsWith('.') ? dequoted.slice(0, -1).trim() : dequoted;
}
