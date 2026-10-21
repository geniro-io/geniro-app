import { describe, expect, it } from 'vitest';

import { foldTaskLists } from '../../../utils/task-list-fold';
import { parseCursorPlan, parseCursorTodos } from './cursor-todos.utils';

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

/**
 * TRANSCRIBED from the wire — cursor-agent 2026.10.19-6bbf2c4, 2026-10-21, a
 * plan-mode turn asking for a three-file plan, then a turn executing it. The
 * frames are written out in `cursor-acp.const.ts`'s plan block.
 */
const CREATE_PLAN = {
  toolCallId: 'call-9d94fff3-0',
  name: 'Create three files',
  overview: 'Create a.txt, b.txt, and c.txt in the workspace folder.',
  plan: '# Create three text files\n…',
  todos: [
    {
      id: 'create-a-txt',
      content: 'Create a.txt containing "alpha"',
      status: 'pending',
    },
    {
      id: 'create-b-txt',
      content: 'Create b.txt containing "beta"',
      status: 'pending',
    },
    {
      id: 'create-c-txt',
      content: 'Create c.txt containing "gamma"',
      status: 'pending',
    },
  ],
};
/** The execution turn's first two `cursor/update_todos` frames. */
const EXECUTION = [
  {
    toolCallId: 'call-1c417799-3',
    merge: true,
    todos: [
      {
        id: 'create-a-txt',
        content: 'Create a.txt containing "alpha"',
        status: 'in_progress',
      },
      {
        id: 'create-b-txt',
        content: 'Create b.txt containing "beta"',
        status: 'pending',
      },
      {
        id: 'create-c-txt',
        content: 'Create c.txt containing "gamma"',
        status: 'pending',
      },
    ],
  },
  {
    toolCallId: 'call-997d9633-6',
    merge: true,
    todos: [
      {
        id: 'create-a-txt',
        content: 'Create a.txt containing "alpha"',
        status: 'completed',
      },
      {
        id: 'create-b-txt',
        content: 'Create b.txt containing "beta"',
        status: 'in_progress',
      },
    ],
  },
];

describe('parseCursorPlan', () => {
  it('reads the plan’s todos with cursor’s own ids', () => {
    expect(parseCursorPlan(CREATE_PLAN)).toEqual([
      {
        id: 'create-a-txt',
        title: 'Create a.txt containing "alpha"',
        status: 'pending',
        activeForm: null,
      },
      {
        id: 'create-b-txt',
        title: 'Create b.txt containing "beta"',
        status: 'pending',
        activeForm: null,
      },
      {
        id: 'create-c-txt',
        title: 'Create c.txt containing "gamma"',
        status: 'pending',
        activeForm: null,
      },
    ]);
  });

  it('is the list the execution turn’s patches join, so no task is drawn twice', () => {
    // The point of reading the plan here rather than off its `plan` update:
    // that update carries no ids, and the patches below name these. Folded the
    // way the run's list is, the plan and its execution are ONE list of three.
    const plan = parseCursorPlan(CREATE_PLAN);
    const rows = [
      { mode: 'snapshot', tasks: plan, toolCallId: null },
      ...EXECUTION.map((frame) => parseCursorTodos(frame)),
    ].map((payload) => ({ nodeId: null, payload }));

    expect(foldTaskLists(rows)[0]?.tasks).toEqual([
      {
        id: 'create-a-txt',
        title: 'Create a.txt containing "alpha"',
        status: 'completed',
        activeForm: null,
      },
      {
        id: 'create-b-txt',
        title: 'Create b.txt containing "beta"',
        status: 'in_progress',
        activeForm: null,
      },
      {
        id: 'create-c-txt',
        title: 'Create c.txt containing "gamma"',
        status: 'pending',
        activeForm: null,
      },
    ]);
  });

  it('reads `cancelled` — a status only the plan carries — as unknown', () => {
    expect(
      parseCursorPlan({
        todos: [{ id: 'x', content: 'y', status: 'cancelled' }],
      }),
    ).toEqual([{ id: 'x', title: 'y', status: null, activeForm: null }]);
  });

  it('refuses a payload carrying no list, so the driver falls back to the plan update', () => {
    expect(parseCursorPlan({ name: 'A plan' })).toBeNull();
    expect(parseCursorPlan(null)).toBeNull();
  });
});
