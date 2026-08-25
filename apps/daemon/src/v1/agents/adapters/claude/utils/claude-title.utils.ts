import { readTitleAnswer } from '../../utils/title-prompt.utils';

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
  const result = typeof row.result === 'string' ? row.result : '';
  // What counts as an ANSWER is the shared prompt's business, not this CLI's:
  // the two are one contract, and a model that explains itself instead of
  // naming the chat does it on every transport.
  return result.trim() === '' ? null : readTitleAnswer(result);
}
