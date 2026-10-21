import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { AcpTodoUpdate } from '../../acp/acp-driver';
import type { AgentTask, AgentTaskStatus } from '../../adapter.types';

/**
 * Reading cursor's own task list off its `cursor/update_todos` request, and a
 * plan's off its `cursor/create_plan` request.
 *
 * The frames this parses are transcribed in `cursor-acp.const.ts`'s task-list
 * section. Two of its fields are the whole reason the agent-agnostic event has
 * the shape it does: `merge` says whether the payload is the list or a patch of
 * it, and `toolCallId` ties it to the `Update TODOs` row it should replace.
 */

/** Only the vocabulary observed; an unknown status is reported as unknown. */
function readStatus(value: unknown): AgentTaskStatus | null {
  const status = asString(value);
  return status === 'pending' ||
    status === 'in_progress' ||
    status === 'completed'
    ? status
    : null;
}

/**
 * Read cursor's `todos` rows — the same `{id, content, status}` shape on both
 * methods that carry them — or null when there is no list.
 *
 * A row with no id is DROPPED rather than positioned, unlike claude's
 * `TodoWrite`: cursor sends real ids and its patches are keyed by them, so a
 * row without one cannot be joined to anything, and inventing an index for it
 * would silently overwrite whichever task happened to sit there.
 */
function readTodoRows(value: unknown): AgentTask[] | null {
  if (!Array.isArray(value)) {
    // An absent list is not an empty one. Reading it as "the agent has no
    // tasks" would let a drifted payload wipe a list the user is watching.
    return null;
  }
  return asArray(value)
    .map((entry): AgentTask | null => {
      const row = asRecord(entry);
      const id = row ? asString(row.id) : null;
      if (id === null || id.length === 0) {
        return null;
      }
      const title = asString(row?.content);
      return {
        id,
        title: title !== null && title.length > 0 ? title : null,
        status: readStatus(row?.status),
        // Cursor's rows carry `{id, content, status}` and nothing else — no
        // present-continuous label to show while a task runs.
        activeForm: null,
      };
    })
    .filter((task): task is AgentTask => task !== null);
}

/**
 * Read a `cursor/update_todos` payload, or null when it does not read as one —
 * which the driver turns back into the ordinary decline.
 */
export function parseCursorTodos(params: unknown): AcpTodoUpdate | null {
  const record = asRecord(params);
  const tasks = record ? readTodoRows(record.todos) : null;
  if (record === null || tasks === null) {
    return null;
  }
  return {
    // The agent SAYS which it sent, so nothing is inferred from the contents:
    // `merge:true` names only the rows that moved (measured — the second
    // announcement of a three-item list carried two of its three rows),
    // `merge:false` is the list in full.
    //
    // An ABSENT `merge` reads as a patch, which is the direction that fails
    // safely rather than the one that matches the opening frame: a snapshot
    // mistaken for a patch leaves a deleted task on screen, while a patch
    // mistaken for a snapshot deletes every task it did not name — the list of
    // seven the user is watching becomes the two that just moved.
    mode: record.merge === false ? 'snapshot' : 'patch',
    tasks,
    toolCallId: asString(record.toolCallId),
  };
}

/**
 * Read the plan off a `cursor/create_plan` request — the plan's todos with the
 * ids its later `cursor/update_todos` patches name, which the `plan` update sent
 * just before it lacks. Null when the payload carries no list.
 *
 * The frames are transcribed in `cursor-acp.const.ts`'s plan block. The rest of
 * the payload (name, overview, the plan document) is the `Create Plan` tool
 * row's, which shows it; only the list is read here.
 */
export function parseCursorPlan(params: unknown): AgentTask[] | null {
  const record = asRecord(params);
  return record ? readTodoRows(record.todos) : null;
}
