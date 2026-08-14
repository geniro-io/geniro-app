import { describe, expect, it } from 'vitest';

import { parseCursorTodos } from './cursor-todos.utils';

/**
 * Every payload here is TRANSCRIBED from the wire — cursor-agent
 * 2026.08.11-e8db854, 2026-08-14, a prompt asking for a tracked three-step job.
 * The frames are written out in `cursor-acp.const.ts`'s task-list block.
 */

const OPENING = {
  toolCallId: 'toolu_vrtx_01BgZhtDupDPsF5KXT9s43eH',
  merge: false,
  todos: [
    { id: '1', content: 'Read alpha.txt', status: 'in_progress' },
    { id: '2', content: 'Read beta.txt', status: 'pending' },
    {
      id: '3',
      content: "Write summary.txt with both files' contents",
      status: 'pending',
    },
  ],
};

describe('parseCursorTodos', () => {
  it('reads `merge:false` as the whole list', () => {
    expect(parseCursorTodos(OPENING)).toEqual({
      mode: 'snapshot',
      toolCallId: 'toolu_vrtx_01BgZhtDupDPsF5KXT9s43eH',
      tasks: [
        {
          id: '1',
          title: 'Read alpha.txt',
          status: 'in_progress',
          activeForm: null,
        },
        {
          id: '2',
          title: 'Read beta.txt',
          status: 'pending',
          activeForm: null,
        },
        {
          id: '3',
          title: "Write summary.txt with both files' contents",
          status: 'pending',
          activeForm: null,
        },
      ],
    });
  });

  it('reads `merge:true` as a PATCH of the rows it names', () => {
    // The measured second announcement: two rows of a three-item list. Read as a
    // snapshot it would delete the third task off the user's screen while the
    // agent was still going to do it.
    expect(
      parseCursorTodos({
        toolCallId: 'toolu_vrtx_01NQ',
        merge: true,
        todos: [
          { id: '1', content: 'Read alpha.txt', status: 'completed' },
          { id: '2', content: 'Read beta.txt', status: 'in_progress' },
        ],
      }),
    ).toMatchObject({ mode: 'patch', toolCallId: 'toolu_vrtx_01NQ' });
  });

  it('treats an ABSENT `merge` as a patch — the direction that fails safely', () => {
    // Not the shape observed (every frame states `merge`), which is exactly why
    // the default has to be chosen deliberately: guessing snapshot deletes every
    // task the payload did not name, guessing patch leaves one stale row.
    expect(
      parseCursorTodos({ todos: [{ id: '1', content: 'x' }] }),
    ).toMatchObject({ mode: 'patch' });
  });

  it('drops a row with no id rather than positioning it', () => {
    // Cursor's patches are keyed by id, so a row without one cannot be joined to
    // anything — and inventing an index would overwrite whichever task happened
    // to sit at that position.
    const update = parseCursorTodos({
      merge: false,
      todos: [{ content: 'nameless' }, { id: '2', content: 'real' }],
    });
    expect(update?.tasks).toEqual([
      { id: '2', title: 'real', status: null, activeForm: null },
    ]);
  });

  it('refuses a payload carrying no list at all', () => {
    // An absent list is not an empty one: reading it as "no tasks" would let a
    // drifted payload wipe the list the user is watching. Null falls through to
    // the driver's ordinary decline.
    expect(parseCursorTodos({ toolCallId: 'x', merge: true })).toBeNull();
    expect(parseCursorTodos(null)).toBeNull();
    expect(parseCursorTodos('nope')).toBeNull();
  });

  it('reads an EMPTY list as an empty list, when the agent sent one', () => {
    expect(parseCursorTodos({ merge: false, todos: [] })).toEqual({
      mode: 'snapshot',
      tasks: [],
      toolCallId: null,
    });
  });
});
