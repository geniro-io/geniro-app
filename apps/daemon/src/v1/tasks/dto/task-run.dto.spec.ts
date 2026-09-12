import { describe, expect, it } from 'vitest';

import { startTaskRunSchema } from './task-run.dto';

/**
 * `startedBy` is what three guards key off — the autopilot's concurrency cap,
 * its failure breaker, and `resolveRunTarget`'s forced approval mode and
 * workflow refusal (see the schema's own doc comment) — and none of them see
 * a value the SCHEMA drops. Zod strips a key the DTO does not declare before
 * the service's input type is ever consulted, so a rewrite of this schema
 * that omits the field disables every one of those guards silently: the
 * autopilot would run past its cap, past an open breaker, and start a
 * workflow unattended, all without the service changing a line.
 */
describe('startTaskRunSchema — startedBy reaches the service', () => {
  const valid = {
    cwd: '/tmp/geniro-task-run-dto-spec',
    branch: 'geniro/task-1',
    from: 'todo',
  };

  it('keeps an explicit `startedBy` on the parsed body', () => {
    const parsed = startTaskRunSchema.parse({
      ...valid,
      startedBy: 'autopilot',
    });

    expect(parsed.startedBy).toBe('autopilot');
  });

  it('leaves `startedBy` absent when the caller sends none', () => {
    const parsed = startTaskRunSchema.parse(valid);

    expect('startedBy' in parsed).toBe(false);
  });

  it('refuses a value outside the enum rather than passing it through', () => {
    expect(
      startTaskRunSchema.safeParse({ ...valid, startedBy: 'conductor' })
        .success,
    ).toBe(false);
  });
});
