import { asRecord, asString } from '../../../utils/json-util';
import type {
  RecoveredSubagentOutcome,
  SubagentRecoveryRef,
} from '../../adapter.types';
import { CODEX_THREAD_ID_PATTERN } from '../codex.const';
import { subagentOutcomeOf } from './codex-items.utils';

export function isCodexSubagentRecoveryRef(ref: SubagentRecoveryRef): boolean {
  return (
    ref.childSessionId !== null &&
    CODEX_THREAD_ID_PATTERN.test(ref.childSessionId) &&
    CODEX_THREAD_ID_PATTERN.test(ref.sessionId) &&
    Number.isFinite(ref.launchedAtMs) &&
    ref.launchedAtMs >= 0
  );
}

/** Only Codex's native parent relationship and latest dated turn prove an ending. */
export function recoverCodexSubagent(
  ref: SubagentRecoveryRef,
  result: unknown,
): RecoveredSubagentOutcome | null {
  if (!isCodexSubagentRecoveryRef(ref)) {
    return null;
  }
  const thread = asRecord(asRecord(result)?.thread);
  if (
    thread?.id !== ref.childSessionId ||
    thread?.parentThreadId !== ref.sessionId
  ) {
    return null;
  }
  const runtimeStatus = asString(asRecord(thread.status)?.type);
  // A live reading outranks a saved turn that has already ended.
  if (runtimeStatus === 'active') {
    return null;
  }
  const turns = thread.turns;
  const latest = Array.isArray(turns) ? asRecord(turns.at(-1)) : null;
  const outcome = subagentOutcomeOf(asString(latest?.status));
  const startedAt = latest?.startedAt;
  const completedAt = latest?.completedAt;
  if (
    outcome === null ||
    outcome === 'untracked' ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    completedAt <= 0 ||
    completedAt < startedAt ||
    completedAt * 1000 < ref.launchedAtMs
  ) {
    return null;
  }
  return outcome;
}
