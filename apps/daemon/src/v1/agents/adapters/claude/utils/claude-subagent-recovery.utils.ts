import { asArray, asRecord, asString } from '../../../utils/json-util';
import { isPlainSessionId } from '../../../utils/session-id';
import type {
  RecoveredSubagentOutcome,
  SubagentRecoveryRef,
} from '../../adapter.types';
import {
  CLAUDE_PERSISTED_DELEGATE_COMPLETED,
  CLAUDE_PERSISTED_TASK_ID,
  CLAUDE_PERSISTED_TASK_ORIGIN_KIND,
  CLAUDE_PERSISTED_TASK_PRODUCER,
  CLAUDE_PERSISTED_TASK_PROMPT_SOURCE,
  CLAUDE_PERSISTED_TASK_STATUS,
  CLAUDE_PERSISTED_TASK_TOOL_ID,
  CLAUDE_TASK_NOTIFICATION_SUBTYPE,
  CLAUDE_TASK_TERMINAL_STATUSES,
} from '../claude.const';
import { eachJsonLine, findSessionFile } from './claude-sessions.utils';

/** Read only persisted CLI endings; a child's final assistant turn proves none. */
export async function recoverClaudeSubagent(
  profileDir: string,
  ref: SubagentRecoveryRef,
): Promise<RecoveredSubagentOutcome | null> {
  if (!isPlainSessionId(ref.sessionId) || !isPlainSessionId(ref.toolCallId)) {
    return null;
  }
  const path = await findSessionFile(profileDir, ref.sessionId, ref.cwd);
  if (path === null) {
    return null;
  }
  let outcome: RecoveredSubagentOutcome | null = null;
  let malformed = false;
  try {
    const read = await eachJsonLine(
      path,
      null,
      (line) => {
        if (line.type !== 'user') {
          return true;
        }
        const sessionId = asString(line.sessionId);
        if (sessionId !== null && sessionId !== ref.sessionId) {
          return true;
        }
        const reading = persistedEnding(line, ref.toolCallId);
        if (reading !== undefined) {
          const at = Date.parse(asString(line.timestamp) ?? '');
          if (!Number.isFinite(at)) {
            outcome = null;
          } else if (at >= ref.launchedAtMs) {
            outcome = reading;
          }
        }
        return true;
      },
      () => {
        malformed = true;
      },
      // Both endings carry the tool call id verbatim — the foreground result as
      // `tool_use_id`, the notification inside its `<tool-use-id>` — and
      // nothing else in the file is read, so every other line is skipped
      // unparsed.
      ref.toolCallId,
    );
    return read && !malformed ? outcome : null;
  } catch {
    // A partial/unreadable read cannot establish the latest authoritative end.
    return null;
  }
}

function persistedEnding(
  line: Record<string, unknown>,
  toolCallId: string,
): RecoveredSubagentOutcome | null | undefined {
  const content = asRecord(line.message)?.content;
  const results = asArray(content)
    .map(asRecord)
    .filter((block) => block?.type === 'tool_result');
  const result = asRecord(line.toolUseResult);
  if (
    asString(result?.status) &&
    asString(result?.agentId) &&
    results.length === 1 &&
    results[0]?.tool_use_id === toolCallId
  ) {
    return result?.status === CLAUDE_PERSISTED_DELEGATE_COMPLETED
      ? results[0].is_error === true
        ? 'failed'
        : 'completed'
      : null;
  }

  // The XML also appears in ordinary quoted user text. Only the CLI's typed
  // system-origin envelope makes it a lifecycle assertion.
  const origin = asRecord(line.origin);
  if (
    origin?.kind !== CLAUDE_PERSISTED_TASK_ORIGIN_KIND ||
    origin.producer !== CLAUDE_PERSISTED_TASK_PRODUCER ||
    line.promptSource !== CLAUDE_PERSISTED_TASK_PROMPT_SOURCE ||
    line.turnOrigin !== CLAUDE_TASK_NOTIFICATION_SUBTYPE
  ) {
    return undefined;
  }
  const text =
    typeof content === 'string'
      ? content
      : asArray(content)
          .map(asRecord)
          .filter((block) => block?.type === 'text')
          .map((block) => asString(block?.text) ?? '')
          .join('\n');
  const id = oneTag(text, CLAUDE_PERSISTED_TASK_TOOL_ID);
  const taskId = oneTag(text, CLAUDE_PERSISTED_TASK_ID);
  const status = oneTag(text, CLAUDE_PERSISTED_TASK_STATUS);
  if (id !== toolCallId || taskId === null || !isPlainSessionId(taskId)) {
    return undefined;
  }
  const outcome = CLAUDE_TASK_TERMINAL_STATUSES.get(status ?? '');
  return outcome === undefined || outcome === 'untracked' ? null : outcome;
}

function oneTag(text: string, pattern: RegExp): string | null {
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}
