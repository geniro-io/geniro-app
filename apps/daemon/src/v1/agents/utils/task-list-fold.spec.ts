import { describe, expect, it } from 'vitest';

import {
  foldTaskLists,
  readRunTaskList,
  readTaskAnnouncement,
  writeRunTaskList,
} from './task-list-fold';

/**
 * The shapes here are TRANSCRIBED from real turns driven through this daemon on
 * 2026-08-31, not invented: claude wrote fifteen patches naming one task each
 * and no snapshot at all, cursor wrote one snapshot then patches naming one or
 * two rows. That is the fact the whole fold exists for — the complete list is
 * stated only in the earliest announcements — so a fixture that opened with a
 * tidy snapshot would test a case neither CLI produces.
 */
const snapshot = (
  tasks: { id: string; title?: string; status?: string }[],
): unknown => ({
  mode: 'snapshot',
  tasks: tasks.map((task) => ({
    id: task.id,
    title: task.title ?? null,
    status: task.status ?? 'pending',
    activeForm: null,
  })),
});

const patch = (id: string, status: string): unknown => ({
  mode: 'patch',
  tasks: [{ id, title: null, status, activeForm: null }],
});

const done = (groups: ReturnType<typeof foldTaskLists>): string =>
  groups
    .map(
      (group) =>
        `${group.tasks.filter((t) => t.status === 'completed').length}/${group.tasks.length}`,
    )
    .join(',');

describe('foldTaskLists', () => {
  it('folds a snapshot then patches into the whole list', () => {
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1' }, { id: '2' }]) },
      { nodeId: null, payload: patch('1', 'completed') },
    ]);
    expect(done(groups)).toBe('1/2');
  });

  it('builds the list from patches alone, which is all claude ever sends', () => {
    // No snapshot anywhere — the measured claude shape. A fold that required
    // one would report an empty list for every claude conversation.
    const groups = foldTaskLists([
      { nodeId: null, payload: patch('1', 'in_progress') },
      { nodeId: null, payload: patch('2', 'pending') },
      { nodeId: null, payload: patch('1', 'completed') },
    ]);
    expect(done(groups)).toBe('1/2');
  });

  it('keeps a title a later patch did not restate', () => {
    // claude's `TaskUpdate` sends `{taskId, status}` and no text, so a
    // replacing merge would blank every title the moment work started.
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1', title: 'write specs' }]) },
      { nodeId: null, payload: patch('1', 'completed') },
    ]);
    expect(groups[0]!.tasks[0]!.title).toBe('write specs');
  });

  it('reads a payload with no mode as a PATCH, never as a snapshot', () => {
    // The fail-safe direction: a patch mistaken for a snapshot deletes every
    // task it did not name, turning a list of six into the one that just moved.
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1' }, { id: '2' }]) },
      { nodeId: null, payload: { tasks: [{ id: '1', status: 'completed' }] } },
    ]);
    expect(done(groups)).toBe('1/2');
  });

  it('keeps each agent’s list apart, since both CLIs number tasks from 1', () => {
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1' }]) },
      { nodeId: 'reviewer', payload: snapshot([{ id: '1' }, { id: '2' }]) },
      { nodeId: 'reviewer', payload: patch('1', 'completed') },
    ]);
    expect(done(groups)).toBe('0/1,1/2');
  });

  it('is INDEPENDENT of how much transcript a client happens to hold', () => {
    // The defect this whole column exists to fix, stated as the difference
    // between two folds of the SAME run. A client folds the newest
    // `HISTORY_PAGE` items; the daemon folds every row. Dropping the opening
    // snapshot must not change the daemon's answer, and it visibly changes the
    // windowed one — a total that SHRANK rather than one obviously missing.
    const rows = [
      {
        nodeId: null,
        payload: snapshot([
          { id: '1' },
          { id: '2' },
          { id: '3' },
          { id: '4' },
          { id: '5' },
          { id: '6' },
        ]),
      },
      { nodeId: null, payload: patch('1', 'completed') },
      { nodeId: null, payload: patch('2', 'completed') },
      { nodeId: null, payload: patch('3', 'in_progress') },
    ];
    expect(done(foldTaskLists(rows))).toBe('2/6');
    // What a window that lost the opening announcement would have reported.
    expect(done(foldTaskLists(rows.slice(1)))).toBe('2/3');
  });

  it('skips a row whose payload does not read as an announcement', () => {
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1' }]) },
      { nodeId: null, payload: null },
      { nodeId: null, payload: { tasks: 'not an array' } },
    ]);
    expect(done(groups)).toBe('0/1');
  });
});

describe('readTaskAnnouncement', () => {
  it('drops a task carrying no id, which nothing downstream could key', () => {
    const announcement = readTaskAnnouncement({
      mode: 'snapshot',
      tasks: [{ id: '1' }, { title: 'nameless' }],
    });
    expect(announcement?.tasks).toHaveLength(1);
  });

  it('reads an unrecognised status as null rather than inventing one', () => {
    const announcement = readTaskAnnouncement({
      mode: 'snapshot',
      tasks: [{ id: '1', status: 'blocked' }],
    });
    expect(announcement?.tasks[0]!.status).toBeNull();
  });
});

describe('readRunTaskList / writeRunTaskList', () => {
  it('round-trips a fold', () => {
    const groups = foldTaskLists([
      { nodeId: null, payload: snapshot([{ id: '1', title: 'a' }]) },
      { nodeId: 'n', payload: snapshot([{ id: '1', status: 'completed' }]) },
    ]);
    expect(readRunTaskList(writeRunTaskList(groups))).toEqual(groups);
  });

  it('writes null when no agent has any rows, so the column stays empty', () => {
    expect(writeRunTaskList([])).toBeNull();
    expect(writeRunTaskList([{ nodeId: null, tasks: [] }])).toBeNull();
  });

  it('degrades to no list rather than throwing on unreadable stored text', () => {
    // This runs inside a chat listing: a row an older build wrote must cost
    // that thread its chip, never the whole listing.
    expect(readRunTaskList('{ not json')).toEqual([]);
    expect(readRunTaskList('{"nodeId":null}')).toEqual([]);
    expect(readRunTaskList(null)).toEqual([]);
  });
});
