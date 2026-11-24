import {
  recordOf,
  refusalReason,
  resultTextOf,
  toolCallArgsOf,
} from './tool-result-text';
import type { ToolPair } from './transcript-groups';

/**
 * What a `start_thread` call and its result say, read off the transcript.
 *
 * TWIN PARSER: the call's fields are `StartThreadSchema` in
 * `apps/daemon/src/v1/agents/chat.types.ts`; the result is worded by
 * `startThreadResultText` in
 * `apps/daemon/src/v1/mcp/tools/start-thread/start-thread.reader.ts` — a filed
 * answer's first line is the `StartThreadAnswer` JSON (a card's names its
 * `taskId`, a thread with no card its `startId`), a refusal is `CODE: reason`.
 * The payloads are `z.unknown()` on the wire, so a change to either wording is
 * made on both sides or neither.
 */
export interface ThreadStart {
  title: string | null;
  project: string | null;
  brief: string | null;
  agent: string | null;
  team: string | null;
  /** The board card the call filed, once its result names one. */
  taskId: string | null;
  /** The start of a thread filed with no card, once its result names one. */
  startId: string | null;
  identifier: string | null;
  /** How the daemon answered the call; null while it has not. */
  answer: 'card_shown' | 'starting' | 'refused' | null;
  /** Why it was refused, or the error text of a call that failed. */
  reason: string | null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function filedAnswer(text: string): Record<string, unknown> | null {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine.startsWith('{')) {
    return null;
  }
  try {
    return recordOf(JSON.parse(firstLine));
  } catch {
    return null;
  }
}

export function readThreadStart(pair: ToolPair): ThreadStart {
  const args = toolCallArgsOf(pair.call.payload);
  const base = {
    title: stringField(args, 'title'),
    project: stringField(args, 'project'),
    brief: stringField(args, 'brief'),
    agent: stringField(args, 'agent'),
    team: stringField(args, 'team'),
  };
  const pending = {
    ...base,
    taskId: null,
    startId: null,
    identifier: null,
    answer: null,
    reason: null,
  };
  if (pair.result === null) {
    return pending;
  }
  const payload = recordOf(pair.result.payload);
  const text = resultTextOf(payload?.result)?.trim() ?? '';
  const filed = payload?.isError === true ? null : filedAnswer(text);
  const status = filed?.status;
  const taskId = stringField(filed, 'taskId');
  const startId = stringField(filed, 'startId');
  if (
    (status === 'card_shown' || status === 'starting') &&
    (taskId !== null || startId !== null)
  ) {
    return {
      ...base,
      taskId,
      startId,
      identifier: stringField(filed, 'identifier'),
      answer: status,
      reason: null,
    };
  }
  return {
    ...pending,
    answer: 'refused',
    reason: text === '' ? null : refusalReason(text),
  };
}
