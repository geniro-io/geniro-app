import { describe, expect, it } from 'vitest';

import { mapClaudeMessage } from './claude-message.utils';
import {
  claudeTaskEventFromToolResult,
  claudeTaskEventFromToolUse,
} from './claude-tasks.utils';
import { ClaudeSessionCostLedger } from './claude-usage.utils';

/**
 * The payloads here are TRANSCRIBED from one `-p --output-format stream-json`
 * turn on claude 2.1.232 (2026-08-14), told to build a three-item list and move
 * two of them — the capture written out in `claude.const.ts`'s task-list block.
 * `TodoWrite`'s is the one exception and says so at its own test.
 */

describe('a task list read off a tool CALL', () => {
  it('reads `TaskUpdate` as a PATCH, not as the list', () => {
    // The distinction this pins is the whole reason the event carries a mode: a
    // consumer that reads this one call as the current list shows ONE task where
    // the agent has seven, which is worse than showing none.
    expect(
      claudeTaskEventFromToolUse(
        'TaskUpdate',
        { taskId: '2', status: 'in_progress' },
        'toolu_01B2',
      ),
    ).toEqual({
      type: 'task_list',
      mode: 'patch',
      tasks: [
        { id: '2', title: null, status: 'in_progress', activeForm: null },
      ],
      toolCallId: 'toolu_01B2',
    });
  });

  it('normalizes a numeric task id, so one task cannot become two rows', () => {
    // The id is the join key across announcements, and `1 !== '1'`: a create
    // filed under the string and an update under the number would fold into two
    // half-populated rows in the same list.
    const event = claudeTaskEventFromToolUse(
      'TaskUpdate',
      { taskId: 1, status: 'completed' },
      't',
    );
    expect(event?.type === 'task_list' && event.tasks[0]?.id).toBe('1');
  });

  it('still moves a task whose status it does not recognise', () => {
    // A status of null says "somewhere unknown", which is honest. Dropping the
    // patch instead would leave the row sitting at a stale `in_progress` — a
    // spinner on work that has stopped.
    const event = claudeTaskEventFromToolUse(
      'TaskUpdate',
      { taskId: '3', status: 'deferred' },
      't',
    );
    expect(event?.type === 'task_list' && event.tasks[0]).toEqual({
      id: '3',
      title: null,
      status: null,
      activeForm: null,
    });
  });

  it('says nothing about the list for a `TaskCreate` call', () => {
    // Deliberate, and the reason is on the wire: the created task's id exists
    // only in the RESULT, and a patch with no id cannot be applied to anything.
    expect(
      claudeTaskEventFromToolUse(
        'TaskCreate',
        { subject: 'Read the file', activeForm: 'Reading the file' },
        't',
      ),
    ).toBeNull();
  });

  it('says nothing about the list for an ordinary tool call', () => {
    expect(
      claudeTaskEventFromToolUse('Bash', { command: 'ls' }, 't'),
    ).toBeNull();
  });

  it('reads `TodoWrite` as a full snapshot, numbering its rows by position', () => {
    // NOT a wire capture: this machine's 2.1.232 exposes the `Task*` family and
    // no `TodoWrite`, so this pins the published payload shape and the two
    // decisions taken about it — positional ids (the rows carry none, which is
    // sound only because the call replaces the whole list) and `activeForm`
    // being kept (this family states it in the same payload as the task).
    expect(
      claudeTaskEventFromToolUse(
        'TodoWrite',
        {
          todos: [
            {
              content: 'Read the file',
              status: 'completed',
              activeForm: 'Reading the file',
            },
            { content: 'Edit the file', status: 'in_progress' },
          ],
        },
        'toolu_todo',
      ),
    ).toEqual({
      type: 'task_list',
      mode: 'snapshot',
      tasks: [
        {
          id: '1',
          title: 'Read the file',
          status: 'completed',
          activeForm: 'Reading the file',
        },
        {
          id: '2',
          title: 'Edit the file',
          status: 'in_progress',
          activeForm: null,
        },
      ],
      toolCallId: 'toolu_todo',
    });
  });
});

describe('a task list read off a tool RESULT', () => {
  it('reads a `TaskCreate` result — the only place the new id appears', () => {
    expect(
      claudeTaskEventFromToolResult(
        'Task #1 created successfully: Read the file',
        'toolu_016k',
      ),
    ).toEqual({
      type: 'task_list',
      mode: 'patch',
      tasks: [
        {
          id: '1',
          title: 'Read the file',
          status: 'pending',
          activeForm: null,
        },
      ],
      toolCallId: 'toolu_016k',
    });
  });

  it('reads a `TaskList` result as a SNAPSHOT — the CLI stating the whole list', () => {
    expect(
      claudeTaskEventFromToolResult(
        '#1 [completed] Read the file\n#2 [in_progress] Edit the file\n#3 [pending] Run the tests',
        'toolu_01Ukn',
      ),
    ).toEqual({
      type: 'task_list',
      mode: 'snapshot',
      tasks: [
        {
          id: '1',
          title: 'Read the file',
          status: 'completed',
          activeForm: null,
        },
        {
          id: '2',
          title: 'Edit the file',
          status: 'in_progress',
          activeForm: null,
        },
        {
          id: '3',
          title: 'Run the tests',
          status: 'pending',
          activeForm: null,
        },
      ],
      toolCallId: 'toolu_01Ukn',
    });
  });

  it('reads the same result out of a content-BLOCK array', () => {
    // Claude sends a result as a bare string on some tools and as blocks on
    // others; both shapes are already on record in this module's history.
    const event = claudeTaskEventFromToolResult(
      [{ type: 'text', text: '#7 [pending] Ship it' }],
      't',
    );
    expect(event?.type === 'task_list' && event.tasks).toEqual([
      { id: '7', title: 'Ship it', status: 'pending', activeForm: null },
    ]);
  });

  it('refuses a long output that merely CONTAINS a task-shaped line', () => {
    // The identifying evidence is the sentence itself — a claude `tool_result`
    // block carries `tool_use_id` and no tool name — so a `Bash` call printing
    // this line is exactly the false positive to keep out. Every line must be a
    // task row, which this one is not.
    expect(
      claudeTaskEventFromToolResult(
        'total 3\n#1 [pending] Run the tests\nmake: *** No rule to make target',
        't',
      ),
    ).toBeNull();
    expect(
      claudeTaskEventFromToolResult(
        'here you go: Task #4 created successfully: something',
        't',
      ),
    ).toBeNull();
  });

  it('says nothing about the list for an ordinary result', () => {
    expect(
      claudeTaskEventFromToolResult('Updated task #1 status', 't'),
    ).toBeNull();
    expect(claudeTaskEventFromToolResult('', 't')).toBeNull();
    expect(claudeTaskEventFromToolResult(null, 't')).toBeNull();
  });
});

describe('through the message mapper', () => {
  it('emits the tool row AND the task announcement for one call', () => {
    // Both, deliberately: the tool row is what every other consumer is built on
    // (the tool group, the activity line, the debug log), and only the
    // transcript hides it — by matching this call's id, which is why the event
    // carries it.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01B2',
              name: 'TaskUpdate',
              input: { taskId: '2', status: 'in_progress' },
            },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events.map((event) => event.type)).toEqual([
      'tool_call',
      'task_list',
    ]);
    expect(events[1]?.type === 'task_list' && events[1].toolCallId).toBe(
      'toolu_01B2',
    );
  });

  it('carries the sub-agent origin, so a delegate’s list is the DELEGATE’s', () => {
    // The whole point of the ticket's second half. The origin is stamped by the
    // mapper's own envelope reader, so nothing about tasks had to know about
    // sub-agents — but nothing must strip it either, and this is what says so.
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_child',
              name: 'TaskUpdate',
              input: { taskId: '1', status: 'completed' },
            },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    const task = events.find((event) => event.type === 'task_list');
    expect(task?.parentToolUseId).toBe('toolu_parent');
  });

  it('ignores a task result the tool reported as an ERROR', () => {
    // A failed call moved nothing, and its text is the failure rather than the
    // task — so a create that errored must not add a row.
    const events = mapClaudeMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_016k',
              content: 'Task #1 created successfully: Read the file',
              is_error: true,
            },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events.map((event) => event.type)).toEqual(['tool_result']);
  });
});
