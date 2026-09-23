/** One call a woken caller was told about. */
export interface WakeReason {
  callId: string;
  /** The callee, by the name the caller knows it by. */
  callee: string;
  reason: 'asked' | 'finished';
}

/**
 * The calls a WAKE notice is about, or null when the row is not one.
 *
 * A caller whose turn ended with calls still out is started again when one of
 * them finishes or asks something; the daemon records why as a system row, so
 * the agent is not seen talking again unprompted.
 *
 * TWIN PARSER: written by `wakeNotice` in
 * `apps/daemon/src/v1/graphs/services/call-broker.service.ts`.
 */
export function readWakeNotice(payload: unknown): WakeReason[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as { wake?: unknown }).wake;
  if (!Array.isArray(value)) {
    return null;
  }
  const reasons: WakeReason[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { callId, callee, reason } = entry as Record<string, unknown>;
    if (
      typeof callId === 'string' &&
      callId !== '' &&
      typeof callee === 'string' &&
      (reason === 'asked' || reason === 'finished')
    ) {
      reasons.push({ callId, callee, reason });
    }
  }
  return reasons.length === 0 ? null : reasons;
}
