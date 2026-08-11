/**
 * Defensive readers over a transcript item's payload, and the node metadata
 * the transcript displays.
 *
 * A separate PURE module rather than exports of `transcript-item.tsx`, and the
 * reason is structural, not tidiness: `transcript-groups.ts` needs
 * `payloadString`, and reaching into the component module for it made
 * `agent-activity.ts → transcript-groups.ts → transcript-item.tsx →
 * live-row.tsx → agent-activity.ts` a real import cycle the moment
 * `agent-activity` came to depend on the fold. Every edge in that loop was a
 * value import, so it survived only because each read happened inside a
 * function body — one module-scope use away from a crash. Parking a six-line
 * pure helper in a component module is what made the loop possible; this file
 * is the fix.
 *
 * An item payload is `z.unknown()` on the wire BY DESIGN — every item kind
 * carries a different shape — so every read here is a guard, never a cast.
 */

/** What the transcript knows about a workflow node (for display only). */
export interface TranscriptNodeMeta {
  name: string;
  kind: 'agent' | 'trigger';
}

/** Read a string field out of an item's payload, defensively. */
export function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/** Read a numeric field out of an item's payload, defensively. */
export function payloadNumber(payload: unknown, key: string): number | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}
