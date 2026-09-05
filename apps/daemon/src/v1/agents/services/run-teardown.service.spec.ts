import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { CallContextDao } from '../dao/call-context.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { AttachmentStoreService } from './attachment-store.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunTeardownService } from './run-teardown.service';

/**
 * The teardown's own spec, over REAL DAOs on a real in-memory schema.
 *
 * It exists because every table a run owns is enumerated by hand here — nothing
 * cascades — so the only thing standing between a new table and rows that
 * outlive their run is a line in `purge`. A table's rows are exactly what a
 * fake DAO cannot pin: the spies elsewhere assert that a call was MADE, and
 * this asserts that the rows are GONE.
 */
describe('RunTeardownService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let teardown: RunTeardownService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let callContextDao: CallContextDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, CallContext],
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

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    callContextDao = new CallContextDao(em);
    teardown = new RunTeardownService(
      itemDao,
      nodeStateDao,
      callContextDao,
      runDao,
      new AgentEventBus(),
      // The in-memory planes a delete also clears. Stubbed because none of them
      // touches the database, and what this spec is about is which TABLES the
      // purge reaches.
      { cancel: () => false } as unknown as ProcessRegistry,
      { close: () => undefined } as unknown as AgentSessionRegistry,
      { revokeRun: () => undefined } as unknown as CallTokenRegistry,
      { forgetRun: () => undefined } as unknown as PartialStreamService,
      { removeRun: () => undefined } as unknown as AttachmentStoreService,
      { forget: () => undefined } as unknown as ItemSeqAllocator,
    );
  });

  /** A run holding one node, two of its call threads, and a transcript row. */
  const seedRun = async (runId: string): Promise<void> => {
    await runDao.create({ id: runId, agentKind: 'claude', cwd: '/work' });
    await nodeStateDao.createPending(runId, 'node-a');
    await callContextDao.rememberContext(
      runId,
      'call-1',
      'node-a',
      4200,
      200000,
    );
    await callContextDao.rememberContext(
      runId,
      'call-2',
      'node-a',
      91000,
      200000,
    );
  };

  it('destroys the per-call context rows of the run it deletes', async () => {
    await seedRun('run-a');
    expect(await callContextDao.listByRun('run-a')).toHaveLength(2);

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
  });

  it('leaves another run’s per-call context rows standing', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
    expect(await callContextDao.listByRun('run-b')).toHaveLength(2);
  });

  it('destroys the run’s node states and the run row alongside them', async () => {
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await nodeStateDao.listByRun('run-a')).toHaveLength(0);
    expect(await runDao.getById('run-a', orm.em.fork())).toBeNull();
  });
});
