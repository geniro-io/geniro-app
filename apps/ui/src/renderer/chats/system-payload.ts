/**
 * Who wrote a `system` row's message.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` stamps the
 * `origin` key this reads, from the `notice` event's own `origin` field. An item
 * payload is `z.unknown()` on the wire BY DESIGN — every item kind carries a
 * different shape — so no generated type reaches the renderer and the two sides
 * are independent readings of one shape. Rename the key there and this file must
 * change with it.
 *
 * A plain `.ts` module rather than a helper inside the row component: a pure
 * payload reader parked in a `.tsx` is what previously closed a real value-import
 * cycle in this directory (transcript-groups → transcript-item → live-row →
 * agent-activity), and the row components are not the only readers.
 */

/**
 * True when the CLI wrote the message and geniro is only relaying it.
 *
 * Absent means the DAEMON wrote it, which is every historical notice — a
 * withheld capability, a degrade — and those are correctly surfaced like errors.
 * Text the agent produced is not an advisory and must not be dressed as one;
 * it is also untrusted (a compaction summary describes a conversation that can
 * contain file contents, command output and web pages), so it must never be
 * able to impersonate an application-level warning.
 */
export function isCliAuthored(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  return (payload as { origin?: unknown }).origin === 'cli';
}
