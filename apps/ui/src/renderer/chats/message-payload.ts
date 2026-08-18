/**
 * How a user's `message` row reached the agent.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/services/chat.service.ts`
 * (`deliverIntoRunningTurn`) stamps the `midTurn` key this reads. An item
 * payload is `z.unknown()` on the wire BY DESIGN — every item kind carries a
 * different shape — so no generated type reaches the renderer and the two sides
 * are independent readings of one shape. Rename the key there and this file
 * must change with it.
 *
 * A plain `.ts` module rather than a helper inside the row component, for the
 * reason `system-payload.ts` is one: a pure payload reader parked in a `.tsx`
 * is what previously closed a real value-import cycle in this directory.
 */

/**
 * True when this message was written into a turn that was ALREADY running,
 * rather than being the message that started one.
 *
 * The distinction is invisible in the transcript and is the whole explanation
 * for a wait: a CLI that accepts a mid-turn message acts on it at its next tool
 * boundary, so a message sent behind a long tool call sits there — correctly —
 * while the live row goes on naming the tool that was already running. Absent
 * means the ordinary case, a message that opened its own turn, which needs no
 * caption because there is nothing to explain.
 */
export function wasSentMidTurn(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  return (payload as { midTurn?: unknown }).midTurn === true;
}
