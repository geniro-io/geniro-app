import { describe, expect, it } from 'vitest';

import {
  TASK_DESCRIPTION_MAX,
  TASK_SOURCE_REF_MAX,
  TASK_TITLE_MAX,
} from '../tasks.types';
import {
  createTaskSchema,
  listTasksQuerySchema,
  updateTaskSchema,
} from './task.dto';

/**
 * The schemas rather than the route, deliberately: what a controller binds is
 * a decorator's emitted metadata, which no unit test can observe. What CAN be
 * pinned here is that the schema refuses every shape the listing has to
 * refuse — so a rewrite that keeps the binding and weakens the schema is red,
 * and the sibling `chat.dto.spec.ts` pins its own query schema the same way.
 */
describe('listTasksQuerySchema', () => {
  it('requires a project to scope the listing to', () => {
    // The shape that returned every task row in the database: absent, the key
    // is dropped from the filter rather than matched, so the listing was
    // unscoped and the existence guard passed against an arbitrary project.
    expect(listTasksQuerySchema.safeParse({}).success).toBe(false);
  });

  it('refuses an operator object, which the query parser can produce', () => {
    // `fastify-qs` runs with `comma: true`, so `?projectId[$ne]=x` arrives as
    // an object — and MikroORM honours `$ne` as an operator.
    expect(
      listTasksQuerySchema.safeParse({ projectId: { $ne: 'x' } }).success,
    ).toBe(false);
  });

  it('refuses an array, which a repeated or comma-separated param produces', () => {
    expect(
      listTasksQuerySchema.safeParse({ projectId: ['a', 'b'] }).success,
    ).toBe(false);
  });

  it('refuses a blank project id', () => {
    expect(listTasksQuerySchema.safeParse({ projectId: '' }).success).toBe(
      false,
    );
  });

  it('accepts a plain id and drops any key smuggled beside it', () => {
    const parsed = listTasksQuerySchema.parse({
      projectId: 'p1',
      status: { $ne: 'done' },
    });

    expect(parsed).toEqual({ projectId: 'p1' });
  });
});

describe('createTaskSchema bounds', () => {
  const valid = { projectId: 'p1', title: 'a task' };

  it('accepts a description at the bound and refuses one past it', () => {
    const atMax = 'x'.repeat(TASK_DESCRIPTION_MAX);

    expect(
      createTaskSchema.safeParse({ ...valid, description: atMax }).success,
    ).toBe(true);
    expect(
      createTaskSchema.safeParse({ ...valid, description: `${atMax}x` })
        .success,
    ).toBe(false);
  });

  it('bounds the title and the source reference', () => {
    expect(
      createTaskSchema.safeParse({
        ...valid,
        title: 'x'.repeat(TASK_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        ...valid,
        sourceRef: 'x'.repeat(TASK_SOURCE_REF_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('refuses a blank title, which trims to nothing', () => {
    expect(createTaskSchema.safeParse({ ...valid, title: '   ' }).success).toBe(
      false,
    );
  });
});

describe('updateTaskSchema — the run edge is not a client’s to write', () => {
  it('DROPS every field of the run<->task edge', () => {
    const parsed = updateTaskSchema.parse({
      title: 'still a real patch',
      runId: 'run-1',
      worktreePath: '/tmp/somewhere',
      branch: 'geniro/task-t1',
      reportItemId: 'item-1',
    });

    // `TaskRunsService` guards every write to these — a synchronous claim, a
    // compare-and-set, and a question put to the RUN rather than to the id.
    // Accepting them here bypassed all three at once: clearing `runId` on a
    // card whose agent was live re-opened the start path against the same
    // worktree.
    expect(parsed).toEqual({ title: 'still a real patch' });
  });

  it('still refuses a patch that changes nothing', () => {
    // The edge fields used to be able to satisfy this on their own, so the
    // guard has to be checked against what is LEFT of the schema.
    expect(updateTaskSchema.safeParse({ runId: 'run-1' }).success).toBe(false);
  });

  it('accepts the fields a card actually owns', () => {
    expect(
      updateTaskSchema.safeParse({
        title: 'renamed',
        description: null,
        labels: ['ui'],
        priority: 'high',
        dueDate: null,
      }).success,
    ).toBe(true);
  });
});
