import { describe, expect, it } from 'vitest';

import {
  TASK_DESCRIPTION_MAX,
  TASK_SOURCE_REF_MAX,
  TASK_TITLE_MAX,
} from '../tasks.types';
import { createTaskSchema, listTasksQuerySchema } from './task.dto';

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
