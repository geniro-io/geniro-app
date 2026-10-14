import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { WallTurnDao } from './wall-turn.dao';

describe('WallTurnDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: WallTurnDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [WallTurn],
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
    dao = new WallTurnDao(orm.em.fork());
  });

  it('records a turn once under its key and never updates it', async () => {
    await dao.record('run-1', [{ seq: 4, nodeId: 'eng', ms: 1_000 }]);
    // The same turn measured again — even differently — is the turn already
    // recorded, not a second one.
    await dao.record('run-1', [
      { seq: 4, nodeId: 'eng', ms: 9_999 },
      { seq: 9, nodeId: 'eng', ms: 2_000 },
    ]);

    expect((await dao.nodeSums('run-1')).get('eng')).toBe(3_000);
  });

  it('writes no row for a figure that is not positive', async () => {
    await dao.record('run-1', [
      { seq: 1, nodeId: null, ms: 0 },
      { seq: 2, nodeId: null, ms: -5 },
    ]);

    expect(await orm.em.fork().count(WallTurn, {})).toBe(0);
  });

  it("keeps a node's sums and a chat's apart", async () => {
    await dao.record('run-1', [
      { seq: 1, nodeId: 'eng', ms: 1_000 },
      { seq: 2, nodeId: 'qa', ms: 2_000 },
      { seq: 3, nodeId: null, ms: 4_000 },
    ]);

    expect([...(await dao.nodeSums('run-1'))]).toEqual([
      ['eng', 1_000],
      ['qa', 2_000],
    ]);
    expect([...(await dao.chatSums(['run-1']))]).toEqual([['run-1', 4_000]]);
  });

  it("sums a run's whole wall time — every node's and a chat's — and no other run's", async () => {
    await dao.record('run-1', [
      { seq: 1, nodeId: 'qa', ms: 1_000 },
      { seq: 2, nodeId: null, ms: 2_000 },
    ]);
    await dao.record('run-2', [{ seq: 1, nodeId: 'qa', ms: 9_000 }]);

    expect(await dao.runSum('run-1')).toBe(3_000);
    expect(await dao.runSum('run-3')).toBe(0);
  });

  it('records and sums past one batch', async () => {
    // Over both batch sizes, so a batch loop that stopped after its first
    // round would come up short.
    const ids = Array.from({ length: 1_201 }, (_, i) => `run-${i}`);
    for (const id of ids) {
      await dao.record(id, [{ seq: 1, nodeId: null, ms: 10 }]);
    }
    await dao.record(
      'one',
      Array.from({ length: 1_201 }, (_, i) => ({
        seq: i + 1,
        nodeId: 'eng',
        ms: 1,
      })),
    );

    const sums = await dao.chatSums(ids);
    expect(sums.size).toBe(1_201);
    expect(sums.get('run-1200')).toBe(10);
    expect((await dao.nodeSums('one')).get('eng')).toBe(1_201);
  });
});
