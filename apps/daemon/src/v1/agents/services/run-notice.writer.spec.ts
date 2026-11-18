import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { NO_CALL_INDEX } from '../__tests__/no-call-index';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { itemToWire } from '../utils/item-wire';
import { AgentEventBus } from './agent-events.bus';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunNoticeWriter } from './run-notice.writer';

describe('RunNoticeWriter', () => {
  let orm: MikroORM;
  let itemDao: ItemDao;
  let bus: AgentEventBus;
  let writer: RunNoticeWriter;

  beforeEach(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        schemaGenerator: mikroOrmConfig.schemaGenerator,
      }),
    );
    await orm.schema.update({ safe: true });
    const fork = orm.em.fork();
    fork.persist(
      Object.assign(new Run(), { id: 'run-1', status: 'completed' } as Run),
    );
    await fork.flush();
    itemDao = new ItemDao(orm.em);
    bus = new AgentEventBus();
    writer = new RunNoticeWriter(
      orm.em,
      new RunDao(orm.em),
      itemDao,
      bus,
      NO_CALL_INDEX,
      new ItemSeqAllocator(orm.em, itemDao),
    );
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('writes an info host row that opens no turn, and announces it', async () => {
    const announced: string[] = [];
    bus.all().subscribe(({ item }) => announced.push(item.kind));

    await writer.info('run-1', 'Started "Billing cache"');

    const rows = await itemDao.rowsOfKinds('run-1', ['system']);
    expect(rows.map((row) => itemToWire(row).payload)).toEqual([
      { severity: 'info', message: 'Started "Billing cache"', woke: false },
    ]);
    expect(announced).toEqual(['system']);
  });

  it('writes a warning notice with its caption', async () => {
    await writer.warn('run-1', 'Could not deliver', 'Monitor');

    const rows = await itemDao.rowsOfKinds('run-1', ['system']);
    expect(rows.map((row) => itemToWire(row).payload)).toEqual([
      expect.objectContaining({
        message: 'Could not deliver',
        severity: 'warning',
        caption: 'Monitor',
      }),
    ]);
  });

  it('writes nothing for a run that is gone', async () => {
    await writer.info('gone', 'Started "Billing cache"');

    expect(await itemDao.rowsOfKinds('gone', ['system'])).toEqual([]);
  });
});
