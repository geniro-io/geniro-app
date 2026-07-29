import { asNumber, asRecord, asString } from '../../utils/json-util';
import type { AgentEvent } from '../adapter.types';

/** The argv flag that turns whole-block output into token-level deltas. */
export const PARTIAL_MESSAGES_FLAG = '--include-partial-messages';

/**
 * Map one `stream_event` line to a live text increment, or [] to ignore it.
 *
 * With {@link PARTIAL_MESSAGES_FLAG} the CLI interleaves `stream_event` lines
 * with the ordinary ones; the completed `assistant` message still arrives
 * afterwards and remains the durable record. Only `text_delta` is lifted:
 *
 * - `input_json_delta` streams a TOOL'S arguments — a large Write's whole file
 *   content would cross the wire twice for no benefit.
 * - `thinking_delta` carries `thinking: ""` — claude redacts reasoning text in
 *   headless mode (probe-verified: the block ships an encrypted `signature`
 *   and an empty body), so there is nothing to show. Reasoning-delta streaming
 *   is also explicitly out of scope for v1.
 * - `message_start` / `message_delta` / `message_stop` / `content_block_*` are
 *   framing the durable events already express.
 *
 * Verified live on claude-opus-5 alongside `--permission-prompt-tool stdio`:
 * deltas and the `can_use_tool` control dialogue coexist on one stream.
 */
export function mapClaudeStreamEvent(
  root: Record<string, unknown>,
): AgentEvent[] {
  const event = asRecord(root.event);
  if (!event || asString(event.type) !== 'content_block_delta') {
    return [];
  }
  const delta = asRecord(event.delta);
  if (!delta || asString(delta.type) !== 'text_delta') {
    return [];
  }
  const text = asString(delta.text);
  return text ? [{ type: 'text_delta', text }] : [];
}

/**
 * Map claude's `system/thinking_tokens` telemetry to a reasoning-progress
 * signal, or [] when the line carries no usable total.
 *
 * The CLI emits this several times per reasoning stretch (observed at 6.6s /
 * 7.6s / 10.9s / 11.3s of one turn) with a running `estimated_tokens` and a
 * per-event delta. It needs no argv flag. This is the ONLY thinking signal a
 * headless consumer gets — the text itself is redacted.
 */
export function mapClaudeThinkingTokens(
  root: Record<string, unknown>,
): AgentEvent[] {
  const tokens = asNumber(root.estimated_tokens);
  return tokens !== null && tokens > 0
    ? [{ type: 'thinking_progress', tokens }]
    : [];
}

/**
 * Whether `claude --help` advertises the partial-messages flag.
 *
 * `--help` is the cheapest honest source: it is the same binary that would
 * reject the flag on argv, it needs no account and no network, and it cannot
 * start a turn. Absent output (a missing binary, a timeout) reads as "no",
 * which degrades to today's block streaming rather than failing turns.
 */
export function helpAdvertisesPartialMessages(stdout: string | null): boolean {
  return (stdout ?? '').includes(PARTIAL_MESSAGES_FLAG);
}
