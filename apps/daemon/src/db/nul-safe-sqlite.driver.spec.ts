import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ItemDao } from '../v1/agents/dao/item.dao';
import { Item } from '../v1/runs/entity/item.entity';
import { NodeState } from '../v1/runs/entity/node-state.entity';
import { Run } from '../v1/runs/entity/run.entity';
import { NulSafeSqliteDriver } from './nul-safe-sqlite.driver';

/**
 * Real driver, real SQL: the defect is in how MikroORM renders a statement, so
 * a fake could never enter it. Configured like the daemon's own
 * `db/mikro-orm.config.ts`, with explicit entity classes in place of its glob.
 */
describe('NulSafeSqliteDriver (in-memory sqlite)', () => {
  let orm: MikroORM;
  /** What an agent printed when its binary grep hit a NUL — from the traced run. */
  const text = 'still running\u0000 hasPendingAgents';

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        driver: NulSafeSqliteDriver,
        entities: [Run, Item, NodeState],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('writes a transcript row whose text holds a NUL byte, and keeps the byte', async () => {
    // With the stock driver this insert fails `unrecognized token: "'still
    // running"` and the row is lost.
    await new ItemDao(orm.em.fork()).create({
      runId: 'run-a',
      seq: 0,
      kind: 'tool_result',
      payload: JSON.stringify({ result: text }),
      searchText: text,
    });

    const [row] = await new ItemDao(orm.em.fork()).getByRun('run-a');
    expect(row?.searchText).toBe(text);
  });

  it('matches a NUL-bearing value in a WHERE clause, where it is pasted too', async () => {
    const row = await orm.em.fork().findOne(Item, { searchText: text });
    expect(row?.runId).toBe('run-a');
  });
});
