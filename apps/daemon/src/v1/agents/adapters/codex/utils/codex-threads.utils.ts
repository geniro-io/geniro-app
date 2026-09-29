import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentEvent,
  AgentSessionHistory,
  AgentSessionRecord,
} from '../../adapter.types';
import {
  firstLine,
  itemCompletedEvents,
  itemStartedEvents,
  readCodexItem,
} from './codex-items.utils';

/**
 * The conversations a `thread/list` result names, as session rows.
 *
 * codex names a thread itself once it has run a turn (`name`); before that the
 * opening message (`preview`) is the only title there is. Its timestamps are
 * unix SECONDS.
 */
export function readCodexThreads(result: unknown): AgentSessionRecord[] {
  const sessions: AgentSessionRecord[] = [];
  for (const entry of asArray(asRecord(result)?.data)) {
    const thread = asRecord(entry);
    const id = thread ? asString(thread.id) : null;
    if (thread === null || !id) {
      continue;
    }
    const name = asString(thread.name);
    const preview = asString(thread.preview);
    const updated = asNumber(thread.updatedAt) ?? asNumber(thread.createdAt);
    sessions.push({
      id,
      cwd: asString(thread.cwd),
      title: name || (preview ? firstLine(preview) || null : null),
      updatedAt: updated !== null ? updated * 1000 : null,
      snippet: null,
    });
  }
  return sessions;
}

/** The words of a `userMessage` item — its text inputs, joined. */
function userMessageText(item: Readonly<Record<string, unknown>>): string {
  return asArray(item.content)
    .flatMap((input) => {
      const record = asRecord(input);
      const text = record ? asString(record.text) : null;
      return record && asString(record.type) === 'text' && text ? [text] : [];
    })
    .join('\n\n');
}

/**
 * A `thread/read` result as the events an imported conversation replays: the
 * user's messages, the agent's, its reasoning, and each tool call with its
 * result — the newest `limit` of them, with a count of what was left out.
 */
export function codexThreadHistory(
  result: unknown,
  limit: number,
): AgentSessionHistory | null {
  const thread = asRecord(asRecord(result)?.thread);
  if (thread === null) {
    return null;
  }
  const events: AgentEvent[] = [];
  for (const turn of asArray(thread.turns)) {
    for (const entry of asArray(asRecord(turn)?.items)) {
      const item = readCodexItem(entry);
      if (item === null) {
        continue;
      }
      if (item.type === 'userMessage') {
        const text = userMessageText(item.record);
        if (text) {
          events.push({ type: 'user_message', text });
        }
        continue;
      }
      events.push(...itemStartedEvents(item), ...itemCompletedEvents(item));
    }
  }
  const droppedBefore = Math.max(0, events.length - limit);
  return { events: events.slice(droppedBefore), droppedBefore };
}
