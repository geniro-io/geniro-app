import { describe, expect, it } from 'vitest';

import type { TaskChangedEvent } from '../tasks.types';
import { TaskEventBus } from './task-events.bus';

describe('TaskEventBus', () => {
  it('delivers a published change to a subscriber of allChanges()', () => {
    const bus = new TaskEventBus();
    const received: TaskChangedEvent[] = [];
    const sub = bus.allChanges().subscribe((e) => received.push(e));

    bus.publishTaskChanged({ taskId: 't1', projectId: 'p1', status: 'todo' });
    bus.publishTaskChanged({
      taskId: 't2',
      projectId: 'p1',
      status: 'in_progress',
    });

    expect(received).toEqual([
      { taskId: 't1', projectId: 'p1', status: 'todo' },
      { taskId: 't2', projectId: 'p1', status: 'in_progress' },
    ]);
    sub.unsubscribe();
  });

  it('says nothing to a subscriber that attached after the publish', () => {
    // A Subject, not a ReplaySubject: a client that joins late gets its
    // history from the REST fetch, not from this bus — same reasoning as
    // AgentEventBus's `all()`.
    const bus = new TaskEventBus();
    bus.publishTaskChanged({ taskId: 't1', projectId: 'p1', status: 'todo' });

    const received: TaskChangedEvent[] = [];
    const sub = bus.allChanges().subscribe((e) => received.push(e));
    expect(received).toEqual([]);
    sub.unsubscribe();
  });
});
