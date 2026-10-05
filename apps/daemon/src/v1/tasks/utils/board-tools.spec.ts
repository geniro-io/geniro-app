import { describe, expect, it } from 'vitest';

import { CHAT_APPROVAL_MODES, HOST_BOARD_TOOLS } from '../../agents/chat.types';
import { AgentKind } from '../../runs/runs.types';
import {
  BOARD_LIST_TASKS_MAX_LIMIT,
  TASK_DESCRIPTION_MAX,
  TASK_PRIORITIES,
  TASK_RUN_CONFIG_FIELDS,
  TASK_STATUSES,
  TASK_TITLE_MAX,
} from '../tasks.types';
import { BOARD_TOOLS, boardToolArgs } from './board-tools';

const tool = (name: string) => BOARD_TOOLS.find((t) => t.name === name)!;

describe('BOARD_TOOLS — the listing is the whole manual', () => {
  it('defines exactly the board tools the MCP host dispatches', () => {
    expect(BOARD_TOOLS.map((t) => t.name)).toEqual([...HOST_BOARD_TOOLS]);
  });

  it('spells every column, priority, approval mode and agent, and the bounds, in the writers’ schemas', () => {
    // An agent that never saw this repository must fill every field from it.
    for (const name of ['create_task', 'update_task']) {
      const schema = JSON.stringify(tool(name).inputSchema);
      for (const value of [
        ...TASK_STATUSES,
        ...TASK_PRIORITIES,
        ...CHAT_APPROVAL_MODES,
        ...Object.values(AgentKind),
      ]) {
        expect(schema, `${name} never names ${value}`).toContain(`"${value}"`);
      }
      expect(schema).toContain(`1–${TASK_TITLE_MAX} characters`);
      expect(schema).toContain(`${TASK_DESCRIPTION_MAX}`);
      expect(schema).toMatch(/YYYY-MM-DD/);
      // Every column says what it MEANS, not only its name.
      expect(schema).toContain('`in_review` = ');
    }
    const create = tool('create_task');
    expect(create.inputSchema.required).toEqual(['project', 'title']);
    expect(JSON.stringify(create.inputSchema)).toContain('Default `backlog`');
    expect(create.description).toContain(TASK_RUN_CONFIG_FIELDS.join(', '));
    expect(JSON.stringify(tool('list_tasks').inputSchema)).toContain(
      `"maximum":${BOARD_LIST_TASKS_MAX_LIMIT}`,
    );
  });

  it('accepts exactly the arguments each schema lists', () => {
    expect(boardToolArgs('list_projects')).toEqual([]);
    expect(boardToolArgs('get_task')).toEqual(['task']);
    expect(boardToolArgs('update_task')).toEqual(
      expect.arrayContaining(['task', 'status', 'fromStatus', 'report']),
    );
    expect(boardToolArgs('create_task')).not.toContain('runId');
  });
});
