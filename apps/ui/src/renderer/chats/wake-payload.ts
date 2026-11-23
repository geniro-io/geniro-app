export type WakeStatus = 'completed' | 'failed' | 'cancelled';

/** One call a woken caller was told about. */
export interface WakeReason {
  callId: string;
  /** The callee, by the name the caller knows it by. */
  callee: string;
  reason: 'asked' | 'finished';
  calleeNodeId?: string;
  status?: WakeStatus;
  result?: string;
  question?: string;
  options?: string[];
}

/**
 * The calls a WAKE notice is about, or null when the row is not one.
 *
 * A caller whose turn ended with calls still out is started again when one of
 * them finishes or asks something; the daemon records why as a system row, so
 * the agent is not seen talking again unprompted.
 *
 * TWIN PARSER: written by `wakeNotice` in
 * `apps/daemon/src/v1/teams/services/call-broker.service.ts`.
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
    const reason = readWakeReason(entry);
    if (reason !== null) {
      reasons.push(reason);
    }
  }
  return reasons.length === 0 ? null : reasons;
}

/**
 * One call a wake entry, or a told-working object, names — null when malformed.
 * The optional keys are read only when they hold their type.
 */
export function readWakeReason(entry: unknown): WakeReason | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const { callId, callee, reason } = record;
  if (
    typeof callId !== 'string' ||
    callId === '' ||
    typeof callee !== 'string' ||
    (reason !== 'asked' && reason !== 'finished')
  ) {
    return null;
  }
  const wake: WakeReason = { callId, callee, reason };
  if (typeof record.calleeNodeId === 'string' && record.calleeNodeId !== '') {
    wake.calleeNodeId = record.calleeNodeId;
  }
  if (isWakeStatus(record.status)) {
    wake.status = record.status;
  }
  if (typeof record.result === 'string') {
    wake.result = record.result;
  }
  if (typeof record.question === 'string') {
    wake.question = record.question;
  }
  if (Array.isArray(record.options)) {
    wake.options = record.options.filter(
      (option): option is string => typeof option === 'string',
    );
  }
  return wake;
}

function isWakeStatus(value: unknown): value is WakeStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}
