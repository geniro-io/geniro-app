/**
 * A call id in words: `call-10` → `Call 10`. An id not of the broker's shape is
 * returned as it is rather than guessed at.
 */
export function callTitle(callId: string): string {
  const match = /^call-(\d+)$/.exec(callId);
  return match === null ? callId : `Call ${match[1]}`;
}
