import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import { ItemDao } from '../dao/item.dao';
import { callsClosedBy, interruptionOf } from './run-interruption';

describe('run-interruption (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let itemDao: ItemDao;
  let seq: number;

  const row = (kind: ItemKind, payload: Record<string, unknown>) =>
    itemDao.create({
      runId: 'run-1',
      seq: (seq += 1),
      kind,
      role: null,
      payload: JSON.stringify(payload),
    });

  const interrupted = (cause: string) =>
    row('error', {
      message: 'run interrupted',
      interrupted: true,
      interruptCause: cause,
    });

  const callResult = (payload: Record<string, unknown>) =>
    row('call_result', { callerNodeId: 'manager', mode: 'async', ...payload });

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Item],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    itemDao = new ItemDao(em);
    seq = 0;
  });

  it.each(['quit', 'self-update', 'restart', 'crash'])(
    'reads a %s interruption that the reconcile’s trailers follow',
    async (cause) => {
      await row('message', { text: 'working on it' });
      await interrupted(cause);
      await row('status', { nodeId: 'engineer', status: 'failed' });
      await callResult({
        callId: 'call-1',
        calleeNodeId: 'engineer',
        status: 'error',
      });

      expect(await interruptionOf(itemDao, 'run-1', em)).toEqual({
        cause,
        seq: 2,
      });
    },
  );

  it('reads no interruption once the run has moved on past it', async () => {
    await interrupted('quit');
    await row('message', { text: 'continue' });

    expect(await interruptionOf(itemDao, 'run-1', em)).toBeNull();
  });

  it('names only the well-formed calls the reconcile closed after the interruption', async () => {
    await callResult({ callId: 'call-0', calleeNodeId: 'qa', status: 'error' });
    const interruption = {
      cause: 'quit' as const,
      seq: (await interrupted('quit')).seq,
    };
    await callResult({
      callId: 'call-1',
      calleeNodeId: 'engineer',
      status: 'error',
    });
    await callResult({ callId: 'call-2', status: 'error' });
    await callResult({ callId: 'call-3', calleeNodeId: 'qa', status: 'ok' });

    expect(await callsClosedBy(itemDao, 'run-1', interruption, em)).toEqual([
      { callId: 'call-1', callee: 'engineer', again: false },
    ]);
  });
});
