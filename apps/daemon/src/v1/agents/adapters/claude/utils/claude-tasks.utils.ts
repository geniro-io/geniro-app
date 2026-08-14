import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentEvent,
  AgentTask,
  AgentTaskStatus,
} from '../../adapter.types';
import {
  CLAUDE_TASK_CREATED_RESULT,
  CLAUDE_TASK_LIST_ROW,
  CLAUDE_TASK_UPDATE_TOOL,
  CLAUDE_TODO_WRITE_TOOL,
} from '../claude.const';

/**
 * Reading claude's own task list off its stream.
 *
 * The list is assembled from BOTH directions of a tool call, and that is forced
 * by the CLI rather than chosen: a `TaskCreate`'s id exists only in its result
 * (`Task #1 created successfully: …`) while a `TaskUpdate`'s status exists only
 * in its input, and `TaskList`'s result is the one place the whole list is
 * stated. `claude.const.ts`'s task-list section carries the wire capture.
 *
 * Everything here is a PURE function of one payload — no correlation state, no
 * memory of earlier calls — which is what keeps it testable without a process
 * and safe under graph fan-out, where one adapter serves many turns. The price
 * is paid in exactly one place, named at {@link claudeTaskEventFromToolUse}:
 * a created task's `activeForm` cannot be attached to it, because the id it
 * would attach to arrives in a later message.
 */

/** Only the vocabulary both shipped CLIs use; anything else is unknown, not guessed. */
function readStatus(value: unknown): AgentTaskStatus | null {
  const status = asString(value);
  return status === 'pending' ||
    status === 'in_progress' ||
    status === 'completed'
    ? status
    : null;
}

/**
 * A task id as claude states it — `"1"` on an update's input, `1` inside its own
 * prose. Normalized to a string because the id is the join key across
 * announcements and `1 !== '1'`, which would fold one task into two rows.
 */
function readId(value: unknown): string | null {
  const text = asString(value) ?? asNumber(value)?.toString() ?? null;
  return text !== null && text.length > 0 ? text : null;
}

/**
 * The text of a tool result, which claude sends as a bare string on some tools
 * and as a content-block array on others (both shapes observed in this repo's
 * own history — see `isPermissionChannelFailure`).
 */
function resultText(result: unknown): string | null {
  const direct = asString(result);
  if (direct !== null) {
    return direct;
  }
  const parts = asArray(result)
    .map((block) => {
      const record = asRecord(block);
      return record && asString(record.type) === 'text'
        ? asString(record.text)
        : null;
    })
    .filter((text): text is string => text !== null);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * The task-list announcement a tool CALL carries, or null when this call says
 * nothing about the list.
 *
 * `TaskCreate` is deliberately absent: its input names the task but not its id,
 * and a patch with no id cannot be applied to anything. The creation is read off
 * the result instead ({@link claudeTaskEventFromToolResult}), which is also what
 * loses the `activeForm` the input carried — pairing the two halves would need
 * per-turn correlation state, and the label is cosmetic (the CLI's own
 * `TaskList` view prints the subject, not the active form) while the state this
 * file would have to hold is the kind that cross-wires concurrent turns.
 */
export function claudeTaskEventFromToolUse(
  name: string,
  input: unknown,
  toolCallId: string,
): AgentEvent | null {
  if (name === CLAUDE_TODO_WRITE_TOOL) {
    const tasks = asArray(asRecord(input)?.todos)
      .map((entry, index): AgentTask | null => {
        const row = asRecord(entry);
        const title = row ? asString(row.content) : null;
        if (title === null || title.length === 0) {
          return null;
        }
        return {
          // POSITIONAL, because this tool's rows carry no id of their own. Sound
          // only because the call is a full snapshot: the list is replaced
          // wholesale, so an index means the same thing to writer and reader.
          // A patch numbered this way would attach a status to whatever task
          // happened to sit at that position.
          id: String(index + 1),
          title,
          status: readStatus(row?.status),
          activeForm: (row ? asString(row.activeForm) : null) ?? null,
        };
      })
      .filter((task): task is AgentTask => task !== null);
    return tasks.length > 0
      ? { type: 'task_list', mode: 'snapshot', tasks, toolCallId }
      : null;
  }
  if (name === CLAUDE_TASK_UPDATE_TOOL) {
    const record = asRecord(input);
    const id = readId(record?.taskId);
    const status = readStatus(record?.status);
    // A PATCH: this call names one task and nothing about the others, so a
    // consumer must keep the rest. Sent even when the status is unrecognised, so
    // the row still moves out of whatever state it was in rather than silently
    // sitting at a stale `in_progress`.
    return id === null
      ? null
      : {
          type: 'task_list',
          mode: 'patch',
          tasks: [{ id, title: null, status, activeForm: null }],
          toolCallId,
        };
  }
  return null;
}

/**
 * The task-list announcement a tool RESULT carries, or null.
 *
 * Matched on the CLI's own sentences because the result block carries no tool
 * name (claude sends `tool_use_id` alone), and anchored whole-string for the
 * same reason: the text is the only evidence of which tool produced it.
 */
export function claudeTaskEventFromToolResult(
  result: unknown,
  toolCallId: string,
): AgentEvent | null {
  const text = resultText(result)?.trim();
  if (text === undefined || text === null || text.length === 0) {
    return null;
  }
  const created = CLAUDE_TASK_CREATED_RESULT.exec(text);
  if (created) {
    return {
      type: 'task_list',
      mode: 'patch',
      // `pending` is measured, not assumed: the `TaskList` taken after these
      // creations reported the untouched one as `[pending]`.
      tasks: [
        {
          id: created[1]!,
          title: created[2]!,
          status: 'pending',
          activeForm: null,
        },
      ],
      toolCallId,
    };
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const rows = lines
    .map((line) => CLAUDE_TASK_LIST_ROW.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  // EVERY line must be a task row. A `TaskList` result is nothing but rows, so
  // requiring all of them is what stops a long tool output that happens to
  // contain one such line from being read as the agent's list.
  if (rows.length === 0 || rows.length !== lines.length) {
    return null;
  }
  return {
    type: 'task_list',
    // The one SNAPSHOT claude offers: `TaskList` states the list in full, so it
    // resynchronises a consumer whose patches missed something.
    mode: 'snapshot',
    tasks: rows.map((row) => ({
      id: row[1]!,
      title: row[3]!,
      status: readStatus(row[2]),
      activeForm: null,
    })),
    toolCallId,
  };
}
